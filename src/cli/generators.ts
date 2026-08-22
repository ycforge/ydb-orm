import fs from 'node:fs';
import path from 'node:path';
import {
  PlannedMigration,
  renderMigrationFile,
} from '../migrations/migration-generator.js';

/** Разбивает строку на слова (по не-буквенно-цифровым символам и camelCase). */
function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
}

export function toPascalCase(input: string): string {
  return words(input)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

export function toSnakeCase(input: string): string {
  return words(input)
    .map((w) => w.toLowerCase())
    .join('_');
}

export function toKebabCase(input: string): string {
  return words(input)
    .map((w) => w.toLowerCase())
    .join('-');
}

/**
 * Гарантирует валидный TypeScript-идентификатор класса (#102): `toPascalCase`
 * от имени без буквенных слов ('123', '---') возвращает пустую строку или
 * строку с ведущей цифрой — такой класс не скомпилируется. Валидные имена
 * возвращаются без изменений (обратная совместимость).
 */
export function toValidClassName(input: string): string {
  const name = toPascalCase(input);
  if (!name || /^[0-9]/.test(name)) return `Migration${name}`;
  return name;
}

export interface CreatedFile {
  filePath: string;
  name: string;
}

function writeFile(dir: string, fileName: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  if (fs.existsSync(filePath)) {
    throw new Error(`File already exists: ${filePath}`);
  }
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Последние использованные timestamp и суффикс: защита от коллизии имён
 * файлов миграций (#102). `Date.now()` имеет миллисекундную точность —
 * две генерации в пределах одной миллисекунды (или при скачке часов назад)
 * обязаны получить разные имена, иначе writeFile падает на существующем файле.
 */
let lastTimestamp = 0;
let lastSuffix = 0;

/**
 * Создаёт файл миграции. Без плана — пустой шаблон (migration:create),
 * с планом — заполненный DDL (migration:generate).
 *
 * Имя файла — `<timestamp>-<Name>`; повторная генерация в ту же миллисекунду
 * получает антиколлизионный суффикс `-1`, `-2`, … (#102). Лексикографическая
 * сортировка загрузчика сохраняется: все timestamps одной длины, короткое
 * имя (без суффикса) идёт раньше длиннее.
 */
export function createMigrationFile(
  dir: string,
  name: string,
  plan?: PlannedMigration,
): CreatedFile {
  const now = Date.now();
  let timestamp: number;
  let suffix: number | null = null;
  if (now > lastTimestamp) {
    timestamp = now;
    lastSuffix = 0;
  } else {
    timestamp = lastTimestamp;
    lastSuffix += 1;
    suffix = lastSuffix;
  }
  lastTimestamp = timestamp;

  const pascal = toValidClassName(name);
  const baseName =
    suffix === null
      ? `${timestamp}-${pascal}`
      : `${timestamp}-${pascal}-${suffix}`;
  const filePath = writeFile(
    dir,
    `${baseName}.ts`,
    renderMigrationFile(
      suffix === null
        ? `${pascal}${timestamp}`
        : `${pascal}${timestamp}_${suffix}`,
      baseName,
      plan ?? { up: [], down: [], warnings: [] },
    ),
  );
  return { filePath, name: baseName };
}

/** Создаёт файл сущности (entity:create): `<kebab-name>.entity.ts`. */
export function createEntityFile(dir: string, name: string): CreatedFile {
  const className = toPascalCase(name);
  const tableName = toSnakeCase(name);
  const fileName = `${toKebabCase(name)}.entity.ts`;

  const content = `import {
  YdbBaseEntity,
  YdbColumn,
  YdbEntity,
  YdbPrimaryColumn,
} from '@ycforge/ydb-orm';

@YdbEntity('${tableName}')
export class ${className} extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;
}
`;

  return { filePath: writeFile(dir, fileName, content), name: className };
}
