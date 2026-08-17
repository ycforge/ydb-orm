import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('returns empty list for missing directory', async () => {
    const migrations = await loadMigrationsFromDir(
      path.join(dir, 'not-exists'),
    );
    expect(migrations).toEqual([]);
  });

  it('throws when a file exports no migration class', async () => {
    writeMigration('1000-Bad.mjs', `export const x = 1;`);

    await expect(loadMigrationsFromDir(dir)).rejects.toThrow(
      /does not export a migration class/,
    );
  });
});
