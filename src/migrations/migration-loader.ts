import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { YdbMigration } from './migration.interface.js';

const MIGRATION_FILE_RE = /\.(ts|mts|js|mjs)$/;

/**
 * Загружает миграции из директории: каждый файл `.ts`/`.js`/`.mts`/`.mjs`
 * должен экспортировать класс (default или именованный) с методами up/down.
 * Node ≥ 22.18 импортирует .ts напрямую (type stripping).
 *
 * Имя миграции = имя файла без расширения (`<timestamp>-<Name>`);
 * сортировка — по имени файла.
 */
export async function loadMigrationsFromDir(
  dir: string,
): Promise<YdbMigration[]> {
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter(
      (f) =>
        MIGRATION_FILE_RE.test(f) &&
        !f.endsWith('.d.ts') &&
        !f.endsWith('.map'),
    )
    .sort();

  const migrations: YdbMigration[] = [];
  for (const file of files) {
    const mod = (await import(
      pathToFileURL(path.join(dir, file)).href
    )) as Record<string, any>;

    const migration = instantiateMigration(mod);
    if (!migration) {
      throw new Error(
        `File ${file} does not export a migration class (up/down methods expected)`,
      );
    }
    migration.name ??= file.replace(MIGRATION_FILE_RE, '');
    migrations.push(migration);
  }

  return migrations;
}

/** Ищет в модуле класс или объект миграции и возвращает инстанс. */
function instantiateMigration(
  mod: Record<string, any>,
): YdbMigration | undefined {
  const candidates = [mod.default, ...Object.values(mod)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (
      typeof candidate === 'function' &&
      typeof candidate.prototype?.up === 'function' &&
      typeof candidate.prototype?.down === 'function'
    ) {
      return new candidate() as YdbMigration;
    }
    if (
      typeof candidate.up === 'function' &&
      typeof candidate.down === 'function'
    ) {
      return candidate as YdbMigration;
    }
  }
  return undefined;
}
