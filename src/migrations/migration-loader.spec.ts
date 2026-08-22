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
    // Раньше возвращался [] — опечатка в --dir выглядела как
    // «No pending migrations».
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
      // Раньше такой файл жёстко ронял migration:run/show/check
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
      // Раньше молча брался только первый подошедший класс
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
      // Раньше эвристика могла взять helper вместо миграции или наоборот
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
      // Раньше второй файл с тем же именем молча skip-ался в раннере
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
      // Переименование файла не должно менять идентичность миграции
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
      // Обе «миграции» применились бы, но вторая упала бы на уже
      // выполненном DDL — раньше это всплывало только в рантайме БД
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

  describe('missing directory (#103)', () => {
    it('fails clearly instead of returning []', async () => {
      // Раньше несуществующая директория выглядела как «No pending
      // migrations» — опечатка в --dir была неотличима от пустой директории.
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
