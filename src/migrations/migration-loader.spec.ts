import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadMigrationsFromDir } from './migration-loader.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-orm-migrations-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeMigration = (fileName: string, body: string) =>
  fs.writeFileSync(path.join(dir, fileName), body, 'utf-8');

const upDownClass = (name: string) => `
  export class ${name} {
    async up() {}
    async down() {}
  }`;

describe('loadMigrationsFromDir', () => {
  it('loads migration classes sorted by file name', async () => {
    writeMigration(
      '2000-Second.mjs',
      `export default class Second {
        async up() {}
        async down() {}
      }`,
    );
    writeMigration(
      '1000-First.mjs',
      `export class First {
        async up() {}
        async down() {}
      }`,
    );

    const migrations = await loadMigrationsFromDir(dir);

    expect(migrations.map((m) => m.name)).toEqual([
      '1000-First',
      '2000-Second',
    ]);
    expect(typeof migrations[0].up).toBe('function');
    expect(typeof migrations[0].down).toBe('function');
  });

  it('keeps explicit name from the migration itself', async () => {
    writeMigration(
      '1000-First.mjs',
      `export default class First {
        name = 'custom-name';
        async up() {}
        async down() {}
      }`,
    );

    const migrations = await loadMigrationsFromDir(dir);

    expect(migrations[0].name).toBe('custom-name');
  });

  it('fails clearly for missing directory (#103)', async () => {
    // Previously [] was returned — a typo in --dir looked just like
    // "No pending migrations".
    await expect(
      loadMigrationsFromDir(path.join(dir, 'not-exists')),
    ).rejects.toThrow(/Migration directory does not exist/);
  });

  it('throws when a file exports no migration class', async () => {
    writeMigration('1000-Bad.mjs', `export const x = 1;`);

    await expect(loadMigrationsFromDir(dir)).rejects.toThrow(
      /does not export a migration class/,
    );
  });

  describe('#100 regression: deterministic discovery', () => {
    it('ignores *.spec.* and *.test.* files even when they export no migration', async () => {
      // Previously such a file hard-crashed migration:run/show/check
      writeMigration(
        '1000-Ok.mjs',
        `export default class Ok {
        async up() {}
        async down() {}
      }`,
      );
      writeMigration('2000-Suite.spec.mjs', `export const x = 1;`);
      writeMigration('3000-Suite.test.mjs', `const broken = ;`);
      writeMigration('4000-Suite.spec.ts', `export const x: number = 1;`);

      const migrations = await loadMigrationsFromDir(dir);

      expect(migrations.map((m) => m.name)).toEqual(['1000-Ok']);
    });

    it('ignores declaration files and source maps', async () => {
      writeMigration(
        '1000-Ok.mjs',
        `export default class Ok {
        async up() {}
        async down() {}
      }`,
      );
      writeMigration('2000-Types.d.ts', `export type X = {};`);
      writeMigration('3000-Bundle.map', `{}`);

      const migrations = await loadMigrationsFromDir(dir);

      expect(migrations.map((m) => m.name)).toEqual(['1000-Ok']);
    });

    it('throws a clear error when a file exports several migration classes', async () => {
      // Previously only the first matching class was taken silently
      writeMigration(
        '1000-Multi.mjs',
        `${upDownClass('CreateUsers')}
         ${upDownClass('CreateRoles')}`,
      );

      await expect(loadMigrationsFromDir(dir)).rejects.toThrow(
        /1000-Multi\.mjs exports multiple migration implementations \((CreateRoles, CreateUsers|CreateUsers, CreateRoles)\)/,
      );
    });

    it('treats default and named export of the same class as a single migration', async () => {
      writeMigration(
        '1000-Single.mjs',
        `${upDownClass('Single')}
         export default Single;`,
      );

      const migrations = await loadMigrationsFromDir(dir);

      expect(migrations.map((m) => m.name)).toEqual(['1000-Single']);
    });

    it('throws when a helper class with up/down sits next to a real migration', async () => {
      // Previously the heuristic could pick a helper instead of a migration or vice versa
      writeMigration(
        '1000-Mixed.mjs',
        `${upDownClass('SomeHelper')}
         ${upDownClass('RealMigration')}`,
      );

      await expect(loadMigrationsFromDir(dir)).rejects.toThrow(
        /multiple migration implementations/,
      );
    });

    it('throws on duplicate names from a .ts source and its compiled .js copy', async () => {
      // Previously the second file with the same name was silently skipped in the runner
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ type: 'module' }),
      );
      const body = `export default class Dup {
        async up() {}
        async down() {}
      }`;
      writeMigration('5000-Dup.ts', body);
      writeMigration('5000-Dup.js', body);

      await expect(loadMigrationsFromDir(dir)).rejects.toThrow(
        /5000-Dup\.(ts|js) and 5000-Dup\.(ts|js)/,
      );
    });

    it('throws on duplicate explicit migration names across files', async () => {
      writeMigration(
        '6000-A.mjs',
        `export default class A {
          name = 'shared';
          async up() {}
          async down() {}
        }`,
      );
      writeMigration(
        '6000-B.mjs',
        `export default class B {
          name = 'shared';
          async up() {}
          async down() {}
        }`,
      );

      await expect(loadMigrationsFromDir(dir)).rejects.toThrow(
        /Duplicate migration name "shared" from files/,
      );
    });
  });

  describe('#101 regression: stable content identity', () => {
    it('assigns a sha256 content hash to every loaded migration', async () => {
      const body = `export default class Hashed {
        async up() {}
        async down() {}
      }`;
      writeMigration('1000-Hashed.mjs', body);

      const migrations = await loadMigrationsFromDir(dir);

      expect(migrations[0].hash).toBe(
        createHash('sha256').update(body).digest('hex'),
      );
    });

    it('keeps the hash stable across file renames', async () => {
      // Renaming the file must not change the migration identity
      const body = `export default class Stable {
        async up() {}
        async down() {}
      }`;
      writeMigration('1000-First.mjs', body);
      const before = await loadMigrationsFromDir(dir);

      fs.renameSync(
        path.join(dir, '1000-First.mjs'),
        path.join(dir, '2000-Renamed.mjs'),
      );
      const after = await loadMigrationsFromDir(dir);

      expect(after[0].hash).toBe(before[0].hash);
      expect(after[0].name).toBe('2000-Renamed');
    });

    it('throws when two files have identical content', async () => {
      // Both "migrations" would have applied, but the second would have failed
      // on already-executed DDL — previously this only surfaced at DB runtime
      const body = `export default class Dup2 {
        async up() {}
        async down() {}
      }`;
      writeMigration('1000-One.mjs', body);
      writeMigration('2000-Two.mjs', body);

      await expect(loadMigrationsFromDir(dir)).rejects.toThrow(
        /identical content/,
      );
    });
  });

  describe('#169 regression: file-backed identity only', () => {
    it('assigns content hash to object exports, not just classes', async () => {
      const body = `export default {
        up: async () => {},
        down: async () => {},
      };`;
      writeMigration('1000-Obj.mjs', body);

      const migrations = await loadMigrationsFromDir(dir);

      expect(migrations[0].hash).toBe(
        createHash('sha256').update(body).digest('hex'),
      );
    });

    it('rejects a hash declared on a class export', async () => {
      writeMigration(
        '1000-ClassHash.mjs',
        `export default class ClassHash {
          hash = 'forged-hash';
          async up() {}
          async down() {}
        }`,
      );

      await expect(loadMigrationsFromDir(dir)).rejects.toThrow(
        /1000-ClassHash\.mjs declares its own migration hash \("forged-hash"\)/,
      );
    });

    it('rejects a hash declared on an object export', async () => {
      writeMigration(
        '1000-ObjHash.mjs',
        `export default {
          hash: 'forged-hash',
          up: async () => {},
          down: async () => {},
        };`,
      );

      await expect(loadMigrationsFromDir(dir)).rejects.toThrow(
        /1000-ObjHash\.mjs declares its own migration hash/,
      );
    });

    it('rejects a declared hash diverging from the file content (tamper/legacy path)', async () => {
      // #189 upgrade path: in a real file the declared hash is part of its own
      // content, so it cannot match the contentHash — any declaration means a
      // forgery or an outdated template with a hardcoded hash. The rejection is
      // an intentional breaking change: identity is always content-based, the
      // middle ground of "declared hash = file" is unreachable.
      const declared = 'b'.repeat(64);
      const body = `export default class EqualHash {
        hash = '${declared}';
        async up() {}
        async down() {}
      }`;
      writeMigration('1000-Equal.mjs', body);

      await expect(loadMigrationsFromDir(dir)).rejects.toThrow(
        /1000-Equal\.mjs declares its own migration hash \("b{64}"\) which differs/,
      );
    });

    it('always reassigns the content hash on modified file content', async () => {
      const body = `export default class Mutable {
        async up() {}
        async down() {}
      }`;
      writeMigration('1000-Mutable.mjs', body);
      const before = await loadMigrationsFromDir(dir);

      // A reload would already return the file from the Node import cache;
      // renaming + changing the content mimics a modification.
      fs.writeFileSync(
        path.join(dir, '2000-Mutable.mjs'),
        body.concat('\n// touched\n'),
        'utf-8',
      );
      const after = await loadMigrationsFromDir(dir);
      const changed = after.find((m) => m.name === '2000-Mutable')!;

      expect(changed.hash).not.toBe(before[0].hash);
    });
  });

  describe('missing directory (#103)', () => {
    it('fails clearly instead of returning []', async () => {
      // Previously a nonexistent directory looked like "No pending
      // migrations" — a typo in --dir was indistinguishable from an empty
      // directory.
      const missing = path.join(dir, 'no-such-dir');

      await expect(loadMigrationsFromDir(missing)).rejects.toThrow(
        /Migration directory does not exist: .*no-such-dir/,
      );
    });

    it('fails when the path is a file, not a directory', async () => {
      const filePath = path.join(dir, 'not-a-dir.ts');
      fs.writeFileSync(filePath, '', 'utf-8');

      await expect(loadMigrationsFromDir(filePath)).rejects.toThrow(
        /is not a directory/,
      );
    });

    it('still accepts an existing empty directory', async () => {
      expect(await loadMigrationsFromDir(dir)).toEqual([]);
    });
  });
});
