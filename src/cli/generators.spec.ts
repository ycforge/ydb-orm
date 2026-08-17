import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEntityFile,
  createMigrationFile,
  toKebabCase,
  toPascalCase,
  toSnakeCase,
} from './generators.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-orm-gen-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('case utils', () => {
  it('converts names between cases', () => {
    expect(toPascalCase('user profile')).toBe('UserProfile');
    expect(toPascalCase('user-profile')).toBe('UserProfile');
    expect(toPascalCase('UserProfile')).toBe('UserProfile');
    expect(toSnakeCase('UserProfile')).toBe('user_profile');
    expect(toKebabCase('UserProfile')).toBe('user-profile');
  });
});

describe('createEntityFile', () => {
  it('creates an entity class file', () => {
    const created = createEntityFile(dir, 'user profile');

    expect(path.basename(created.filePath)).toBe('user-profile.entity.ts');
    expect(created.name).toBe('UserProfile');

    const content = fs.readFileSync(created.filePath, 'utf-8');
    expect(content).toContain(`@YdbEntity('user_profile')`);
    expect(content).toContain('export class UserProfile extends YdbBaseEntity');
    expect(content).toContain(`@YdbPrimaryColumn('Uuid')`);
    expect(content).toContain(`from '@ycforge/ydb-orm'`);
  });

  it('refuses to overwrite an existing file', () => {
    createEntityFile(dir, 'photo');
    expect(() => createEntityFile(dir, 'photo')).toThrow(/already exists/);
  });
});

describe('createMigrationFile', () => {
  it('creates an empty migration template', () => {
    const created = createMigrationFile(dir, 'create users');

    expect(path.basename(created.filePath)).toMatch(/^\d+-CreateUsers\.ts$/);

    const content = fs.readFileSync(created.filePath, 'utf-8');
    expect(content).toMatch(
      /export class CreateUsers\d+ implements YdbMigration/,
    );
    expect(content).toContain(`readonly name = "${created.name}";`);
    expect(content.match(/no statements — fill in manually/g)).toHaveLength(2);
  });

  it('creates a migration with DDL from a plan', () => {
    const created = createMigrationFile(dir, 'add photos', {
      up: ['CREATE TABLE `photos` (`uuid` Uuid, PRIMARY KEY (`uuid`))'],
      down: ['DROP TABLE `photos`'],
      warnings: ['Table "photos": extra column "legacy"'],
    });

    const content = fs.readFileSync(created.filePath, 'utf-8');
    expect(content).toContain(
      'await executeSql(executor, "CREATE TABLE `photos` (`uuid` Uuid, PRIMARY KEY (`uuid`))");',
    );
    expect(content).toContain(
      'await executeSql(executor, "DROP TABLE `photos`");',
    );
    expect(content).toContain('WARNING: Table "photos": extra column "legacy"');
  });
});
