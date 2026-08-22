import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { YdbMigration } from './migration.interface.js';

const MIGRATION_FILE_RE = /\.(ts|mts|js|mjs)$/;

/** Декларации и source map не содержат исполняемого кода миграций. */
const NON_CODE_FILE_RE = /(?:\.d\.ts|\.map)$/;

/**
 * Тестовые файлы никогда не являются миграциями (#100):
 * случайно попавший `*.spec.ts`/`*.test.ts` не должен ронять
 * migration:run/show/check.
 */
const TEST_FILE_RE = /\.(spec|test)\.[^./]+$/;

function isMigrationFileName(file: string): boolean {
  if (!MIGRATION_FILE_RE.test(file)) return false;
  if (NON_CODE_FILE_RE.test(file)) return false;
  if (TEST_FILE_RE.test(file)) return false;
  return true;
}

/** Проверяет, что значение похоже на миграцию: класс или объект с up/down. */
function isMigrationLike(candidate: unknown): boolean {
  if (typeof candidate === 'function') {
    const proto = (candidate as { prototype?: unknown }).prototype as
      Record<string, unknown> | null | undefined;
    return Boolean(
      proto &&
      typeof proto.up === 'function' &&
      typeof proto.down === 'function',
    );
  }
  if (candidate && typeof candidate === 'object') {
    const obj = candidate as Record<string, unknown>;
    return typeof obj.up === 'function' && typeof obj.down === 'function';
  }
  return false;
}

interface MigrationCandidate {
  /** Имена экспортов, указывающих на этот класс/объект (для сообщений об ошибках). */
  names: string[];
  create: () => YdbMigration;
}

/**
 * Собирает все экспорты модуля, похожие на миграцию.
 * Экспорт `default` и именованный экспорт одного и того же класса —
 * один кандидат (дедупликация по значению).
 */
function collectCandidates(mod: Record<string, any>): MigrationCandidate[] {
  const byValue = new Map<unknown, MigrationCandidate>();
  for (const [exportName, value] of Object.entries(mod)) {
    if (!isMigrationLike(value)) continue;

    let entry = byValue.get(value);
    if (!entry) {
      entry = {
        names: [],
        create: () =>
          typeof value === 'function'
            ? new (value as new () => YdbMigration)()
            : (value as YdbMigration),
      };
      byValue.set(value, entry);
    }
    entry.names.push(exportName);
  }
  return [...byValue.values()];
}

/**
 * Загружает миграции из директории: каждый файл `.ts`/`.js`/`.mts`/`.mjs`
 * должен экспортировать ровно одну миграцию (default или именованную).
 * Тестовые (`*.spec.*`, `*.test.*`) и декларационные файлы игнорируются (#100).
 * Node ≥ 22.18 импортирует .ts напрямую (type stripping).
 *
 * Имя миграции = имя файла без расширения (`<timestamp>-<Name>`);
 * сортировка — по имени файла. Файлы с одинаковым именем миграции
 * (например, исходник `.ts` рядом со скомпилированной копией `.js`)
 * приводят к ошибке, а не к молчаливому пропуску.
 */
export async function loadMigrationsFromDir(
  dir: string,
): Promise<YdbMigration[]> {
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(isMigrationFileName).sort();

  const migrations: YdbMigration[] = [];
  const fileByName = new Map<string, string>();

  for (const file of files) {
    const mod = (await import(
      pathToFileURL(path.join(dir, file)).href
    )) as Record<string, any>;

    const candidates = collectCandidates(mod);
    if (candidates.length === 0) {
      throw new Error(
        `File ${file} does not export a migration class ` +
          `(expected default or named export of a class or object with up()/down() methods)`,
      );
    }
    // Несколько миграций в одном файле — неоднозначность (#100):
    // раньше молча брался первый подошедший экспорт.
    if (candidates.length > 1) {
      const names = candidates
        .flatMap((c) => c.names)
        .sort()
        .join(', ');
      throw new Error(
        `File ${file} exports multiple migration implementations (${names}). ` +
          `Keep exactly one migration export per file.`,
      );
    }

    const migration = candidates[0].create();
    migration.name ??= file.replace(MIGRATION_FILE_RE, '');

    // Дубли имени (в т.ч. `.ts` + скомпилированный `.js` рядом) —
    // раньше второй файл молча skip-ался или дважды применялся в раннере (#100).
    const duplicateFile = fileByName.get(migration.name);
    if (duplicateFile) {
      throw new Error(
        `Duplicate migration name "${migration.name}" from files ` +
          `${duplicateFile} and ${file}. Remove one of them — likely a compiled copy next to its source.`,
      );
    }
    fileByName.set(migration.name, file);

    migrations.push(migration);
  }

  return migrations;
}
