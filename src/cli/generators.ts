import fs from 'node:fs';
import path from 'node:path';
import {
  PlannedMigration,
  renderMigrationFile,
} from '../migrations/migration-generator.js';
import { YdbPrimitive } from '../core/types.js';
import { validateIdentifier, validateTableName } from '../core/sql-utils.js';
import { isoDurationToMicroseconds } from '../decorators/ttl.decorator.js';

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
  return writeFileAt(path.join(dir, fileName), content);
}

/** Пишет файл по точному пути; существующий файл никогда не перезаписывается. */
function writeFileAt(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
  return createEntityFileFromSpec(dir, buildDefaultEntitySpec(name));
}

// ---------------------------------------------------------------------------
// Генерация сущности по спецификации (#24, интерактивный entity:create).
// ---------------------------------------------------------------------------

/** Хранилище enum-колонки (совпадает с YdbEnumMeta.storage). */
export type YdbEnumStorage = 'Utf8' | 'Int32';

/** Описание одной колонки/свойства генерируемой сущности. */
export interface YdbEntityColumnSpec {
  /** Имя TS-свойства; оно же — имя колонки таблицы. */
  name: string;
  /** YDB-тип колонки (@YdbColumn/@YdbPrimaryColumn). Игнорируется для encrypted-полей. */
  type: YdbPrimitive;
  /** Первичный ключ (@YdbPrimaryColumn). */
  primary?: boolean;
  /** Шифруемое поле (@YdbEncrypted); тип колонки не объявляется (в БД всегда Bytes). */
  encrypted?: boolean;
  /** Blind index для шифруемого поля (по умолчанию true, как у @YdbEncrypted). */
  blindIndex?: boolean;
  /** Enum-колонка: допустимые значения (@YdbEnum). */
  enumValues?: readonly string[];
  /** Хранилище enum: Utf8 (строковое значение) или Int32 (порядковый номер). */
  enumStorage?: YdbEnumStorage;
  /** Автопростановка времени создания (@YdbCreateDateColumn). */
  createDate?: boolean;
  /** Автопростановка времени обновления (@YdbUpdateDateColumn). */
  updateDate?: boolean;
}

/** TTL таблицы (@YdbTtl) для date-like колонки (Date/Datetime/Timestamp). */
export interface YdbEntityTtlSpec {
  /** ISO 8601 duration, например "PT2H" или "P30D". */
  interval: string;
  /** Имя date-like колонки. */
  column: string;
}

/** Спецификация генерируемой сущности. */
export interface YdbEntitySpec {
  className: string;
  tableName: string;
  columns: YdbEntityColumnSpec[];
  ttl?: YdbEntityTtlSpec | null;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Имена, которые нельзя занимать свойствами сущности: члены YdbBaseEntity
 * (Active Record API) и служебные члены любого объекта. Колонка с таким
 * именем скомпилировалась бы, но сломала бы рантайм ORM.
 */
const RESERVED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  'constructor',
  'toJSON',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'setExecutor',
  'setEncryptionProvider',
  'setBlindIndexProvider',
  'setValidationProvider',
  'getMeta',
  'getDbSchema',
  'find',
  'findAll',
  'findOneBy',
  'findBy',
  'count',
  'save',
  'insertMany',
  'updateBy',
  'delete',
  'deleteBy',
  'query',
  '_buildWhereClause',
  '_executeSelect',
  '_executeCount',
  'decryptField',
  'decryptLazyFields',
  'loadRelations',
]);

/** YDB-примитивы, доступные в мастере entity:create (см. core/types.ts). */
export const ENTITY_CREATE_TYPES: readonly YdbPrimitive[] = [
  'Uuid',
  'Utf8',
  'Bytes',
  'Int32',
  'Int64',
  'Bool',
  'Double',
  'Float',
  'Date',
  'Datetime',
  'Timestamp',
  'Json',
  'JsonDocument',
];

/** Типы, для которых имеет смысл @YdbCreateDateColumn/@YdbUpdateDateColumn/TTL. */
const DATE_LIKE_TYPES: readonly YdbPrimitive[] = [
  'Date',
  'Datetime',
  'Timestamp',
];

function isDateLike(type: YdbPrimitive): boolean {
  return DATE_LIKE_TYPES.includes(type);
}

/**
 * Валидирует спецификацию сущности ДО записи файла (#24).
 * Возвращает список проблем (пустой — если всё в порядке); файл не пишется,
 * пока список непуст.
 */
export function validateEntitySpec(spec: YdbEntitySpec): string[] {
  const issues: string[] = [];

  if (!spec || typeof spec !== 'object') {
    return ['entity spec must be an object'];
  }
  if (!IDENTIFIER_RE.test(spec.className ?? '')) {
    issues.push(
      `invalid class name ${JSON.stringify(spec.className)} — ` +
        `must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
  try {
    validateTableName(spec.tableName);
  } catch (err) {
    issues.push((err as Error).message.replace('@YdbEntity: ', '@YdbEntity '));
  }

  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    issues.push('entity must declare at least one column');
    return issues;
  }

  const seen = new Set<string>();
  // Имя enum-типа выводится из имени колонки: карта для детекта коллизий
  // ('foo_bar' и 'fooBar' → FooBarEnum) — два объявления одного типа
  // не компилируются.
  const seenEnumTypeNames = new Map<string, string>();
  let primaryCount = 0;
  let createDateCount = 0;
  let updateDateCount = 0;

  for (const column of spec.columns) {
    const label = column?.name ? `column "${column.name}"` : 'column';
    if (!column || typeof column.name !== 'string') {
      issues.push(`${label}: name is required`);
      continue;
    }
    if (!IDENTIFIER_RE.test(column.name)) {
      // Свойство становится и TS-идентификатором, и SQL-колонкой:
      // требования к обоим совпадают (ASCII буквы/цифры/_).
      issues.push(
        `${label}: invalid property name — must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
      );
    } else {
      try {
        validateIdentifier(column.name, `column "${column.name}"`);
      } catch (err) {
        issues.push((err as Error).message);
      }
      if (RESERVED_PROPERTY_NAMES.has(column.name)) {
        issues.push(
          `${label}: name conflicts with YdbBaseEntity member "${column.name}"`,
        );
      }
    }
    if (seen.has(column.name)) {
      issues.push(`${label}: duplicate column name`);
    }
    seen.add(column.name);

    if (!ENTITY_CREATE_TYPES.includes(column.type)) {
      issues.push(
        `${label}: unsupported YDB type ${JSON.stringify(column.type)} — ` +
          `expected one of: ${ENTITY_CREATE_TYPES.join(', ')}`,
      );
    }

    if (column.primary) primaryCount++;

    if (column.encrypted && column.primary) {
      issues.push(`${label}: primary key cannot be encrypted (@YdbEncrypted)`);
    }
    if (column.enumValues !== undefined) {
      if (!Array.isArray(column.enumValues) || column.enumValues.length === 0) {
        issues.push(`${label}: enum requires at least one value`);
      } else {
        if (new Set(column.enumValues).size !== column.enumValues.length) {
          issues.push(`${label}: duplicate enum values`);
        }
        for (const value of column.enumValues) {
          if (typeof value !== 'string' || value.trim() === '') {
            issues.push(`${label}: enum values must be non-empty strings`);
            break;
          }
        }
        // Нормализация имени члена lossy ("a-b" и "a_b" → A_B): дубликаты
        // членов в одном объявлении enum не компилируются (duplicate
        // identifier), поэтому ловим их до записи файла (#24).
        const valuesByMember = new Map<string, string[]>();
        for (const value of column.enumValues) {
          if (typeof value !== 'string') continue;
          const member = toEnumMemberName(value);
          const list = valuesByMember.get(member) ?? [];
          list.push(value);
          valuesByMember.set(member, list);
        }
        for (const [member, conflicting] of valuesByMember) {
          if (conflicting.length > 1) {
            issues.push(
              `${label}: enum values ${conflicting.map((v) => JSON.stringify(v)).join(' and ')} ` +
                `all normalize to the same TypeScript member "${member}" — ` +
                `make the values distinguishable`,
            );
          }
        }
        // Имена enum-типов выводятся из колонки тоже lossy ('foo_bar' и
        // 'fooBar' → FooBarEnum): два объявления одного типа в файле —
        // duplicate identifier.
        const typeName = enumTypeName(column.name);
        const typeNameOwner = seenEnumTypeNames.get(typeName);
        if (typeNameOwner !== undefined && typeNameOwner !== column.name) {
          issues.push(
            `columns "${typeNameOwner}" and "${column.name}" produce the same ` +
              `enum type name "${typeName}"`,
          );
        } else {
          seenEnumTypeNames.set(typeName, column.name);
        }
        if (
          column.enumStorage !== undefined &&
          column.enumStorage !== 'Utf8' &&
          column.enumStorage !== 'Int32'
        ) {
          issues.push(
            `${label}: enum storage must be "Utf8" or "Int32", got ${JSON.stringify(column.enumStorage)}`,
          );
        }
      }
    } else if (column.enumStorage !== undefined) {
      issues.push(`${label}: enumStorage requires enumValues`);
    }

    if (column.createDate) {
      createDateCount++;
      if (!isDateLike(column.type)) {
        issues.push(
          `${label}: @YdbCreateDateColumn requires a Date/Datetime/Timestamp column`,
        );
      }
    }
    if (column.updateDate) {
      updateDateCount++;
      if (!isDateLike(column.type)) {
        issues.push(
          `${label}: @YdbUpdateDateColumn requires a Date/Datetime/Timestamp column`,
        );
      }
    }
  }

  if (primaryCount === 0) {
    issues.push(
      'entity must declare at least one primary key (@YdbPrimaryColumn)',
    );
  }
  if (createDateCount > 1) {
    issues.push('only one @YdbCreateDateColumn per entity is allowed');
  }
  if (updateDateCount > 1) {
    issues.push('only one @YdbUpdateDateColumn per entity is allowed');
  }

  if (spec.ttl) {
    if (!spec.ttl.column || !seen.has(spec.ttl.column)) {
      issues.push(`TTL references unknown column "${spec.ttl?.column}"`);
    } else {
      const ttlColumn = spec.columns.find((c) => c.name === spec.ttl!.column);
      if (ttlColumn && !isDateLike(ttlColumn.type)) {
        issues.push(
          `TTL column "${spec.ttl.column}" must be Date/Datetime/Timestamp`,
        );
      }
    }
    if (
      !spec.ttl.interval ||
      isoDurationToMicroseconds(spec.ttl.interval) === null
    ) {
      issues.push(
        `TTL interval ${JSON.stringify(spec.ttl?.interval)} is not a valid ` +
          `ISO 8601 duration without calendar parts (e.g. "PT2H", "P30D")`,
      );
    }
  }

  return issues;
}

/** TS-тип свойства, соответствующий семантике маппера (core/mapper.ts). */
function tsPropertyType(column: YdbEntityColumnSpec): string {
  if (column.enumValues) return enumTypeName(column.name);
  switch (column.type) {
    case 'Uuid':
    case 'Utf8':
      return 'string';
    case 'Bytes':
      return 'Uint8Array';
    case 'Int32':
    case 'Double':
    case 'Float':
      return 'number';
    case 'Int64':
      return 'bigint';
    case 'Bool':
      return 'boolean';
    case 'Date':
    case 'Datetime':
    case 'Timestamp':
      return 'Date';
    case 'Json':
    case 'JsonDocument':
      return 'any';
  }
  return 'unknown';
}

/** Имя TS enum-типа для колонки ("status" → StatusEnum, "order_type" → OrderTypeEnum). */
function enumTypeName(propertyName: string): string {
  const pascal = toPascalCase(propertyName);
  return `${pascal}Enum`;
}

/** Строковый литерал в исходнике с одинарными кавычками (стиль .prettierrc). */
function singleQuoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Имя члена enum из строкового значения ("new_order" → NEW_ORDER). */
export function toEnumMemberName(value: string): string {
  const member = value.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (/^[0-9]/.test(member)) return `V_${member}`;
  return member;
}

/**
 * Рендерит исходник сущности в текущем публичном API (@YdbEntity/@YdbColumn/
 * @YdbPrimaryColumn/@YdbEnum/@YdbEncrypted/@YdbTtl/Ydb*-date-колонки).
 * Форматирование соответствует .prettierrc проекта (singleQuote, trailingComma).
 */
export function renderEntityFile(spec: YdbEntitySpec): string {
  const issues = validateEntitySpec(spec);
  if (issues.length) {
    throw new Error(
      `Invalid entity spec:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
  }

  const imports = new Set<string>(['YdbBaseEntity', 'YdbEntity']);
  for (const column of spec.columns) {
    if (column.primary) {
      imports.add('YdbPrimaryColumn');
    } else if (!column.encrypted) {
      imports.add('YdbColumn');
    }
    if (column.createDate) imports.add('YdbCreateDateColumn');
    if (column.updateDate) imports.add('YdbUpdateDateColumn');
    if (column.encrypted) imports.add('YdbEncrypted');
    if (column.enumValues) imports.add('YdbEnum');
  }
  if (spec.ttl) imports.add('YdbTtl');

  const lines: string[] = [];
  lines.push('import {');
  for (const name of [...imports].sort()) {
    lines.push(`  ${name},`);
  }
  lines.push("} from '@ycforge/ydb-orm';");
  lines.push('');

  // Enum-объявления — перед классом (на них ссылаются типы свойств).
  for (const column of spec.columns) {
    if (!column.enumValues) continue;
    lines.push(`export enum ${enumTypeName(column.name)} {`);
    for (const value of column.enumValues) {
      lines.push(`  ${toEnumMemberName(value)} = ${singleQuoted(value)},`);
    }
    lines.push('}');
    lines.push('');
  }

  lines.push(`@YdbEntity('${spec.tableName}')`);
  if (spec.ttl) {
    lines.push(
      `@YdbTtl({ interval: '${spec.ttl.interval}', column: '${spec.ttl.column}' })`,
    );
  }
  lines.push(`export class ${spec.className} extends YdbBaseEntity {`);

  spec.columns.forEach((column, index) => {
    // Порядок соответствует фикстурам/документации:
    // date-декораторы → колонка/PK → шифрование → enum.
    const decorators: string[] = [];
    if (column.createDate) decorators.push('@YdbCreateDateColumn()');
    if (column.updateDate) decorators.push('@YdbUpdateDateColumn()');
    if (column.primary) {
      decorators.push(`@YdbPrimaryColumn('${column.type}')`);
    } else if (!column.encrypted) {
      decorators.push(`@YdbColumn('${column.type}')`);
    }
    if (column.encrypted) {
      decorators.push(
        column.blindIndex === false
          ? '@YdbEncrypted({ blindIndex: false })'
          : '@YdbEncrypted()',
      );
    }
    if (column.enumValues) {
      const storage = column.enumStorage ?? 'Utf8';
      decorators.push(
        `@YdbEnum({ values: Object.values(${enumTypeName(column.name)}), storage: '${storage}' })`,
      );
    }
    for (const decorator of decorators) {
      lines.push(`  ${decorator}`);
    }
    lines.push(`  ${column.name}: ${tsPropertyType(column)};`);
    if (index < spec.columns.length - 1) lines.push('');
  });

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** Путь файла сущности без записи: `<dir>/<kebab-name>.entity.ts`. */
export function entityFilePath(dir: string, name: string): string {
  const kebab = toKebabCase(name);
  const fileName = `${kebab || toPascalCase(name).toLowerCase()}.entity.ts`;
  return path.join(dir, fileName);
}

/**
 * Спецификация «по умолчанию» (неинтерактивный путь entity:create):
 * uuid PK + name — тот же шаблон, что и раньше.
 */
export function buildDefaultEntitySpec(name: string): YdbEntitySpec {
  return {
    className: toValidEntityClassName(name),
    tableName: toSnakeCase(name),
    columns: [
      { name: 'uuid', type: 'Uuid', primary: true },
      { name: 'name', type: 'Utf8' },
    ],
  };
}

/**
 * Валидный TS-идентификатор класса сущности (#102): как toValidClassName,
 * но префикс Entity вместо Migration (миграции не трогаем).
 */
export function toValidEntityClassName(input: string): string {
  const name = toPascalCase(input);
  if (!name || /^[0-9]/.test(name)) return `Entity${name}`;
  return name;
}

/**
 * Создаёт файл сущности по спецификации: сначала полная валидация (#24),
 * затем запись с защитой от перезаписи существующего файла.
 *
 * `filePath` — явный путь (используется CLI-мастером, чтобы pre-check
 * коллизии и фактическая запись гарантированно указывали на один файл);
 * по умолчанию имя файла выводится из имени таблицы.
 */
export function createEntityFileFromSpec(
  dir: string,
  spec: YdbEntitySpec,
  options?: { filePath?: string },
): CreatedFile {
  const issues = validateEntitySpec(spec);
  if (issues.length) {
    throw new Error(
      `Invalid entity spec:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
  }
  const content = renderEntityFile(spec);
  const filePath = options?.filePath
    ? writeFileAt(options.filePath, content)
    : writeFile(dir, `${toKebabCase(spec.tableName)}.entity.ts`, content);
  return { filePath, name: spec.className };
}
