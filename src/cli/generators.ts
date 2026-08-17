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
 * Создаёт файл миграции. Без плана — пустой шаблон (migration:create),
 * с планом — заполненный DDL (migration:generate).
 */
export function createMigrationFile(
  dir: string,
  name: string,
  plan?: PlannedMigration,
): CreatedFile {
  const timestamp = Date.now();
  const baseName = `${timestamp}-${toPascalCase(name)}`;
  const filePath = writeFile(
    dir,
    `${baseName}.ts`,
    renderMigrationFile(
      `${toPascalCase(name)}${timestamp}`,
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
