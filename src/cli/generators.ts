import fs from 'node:fs';
import path from 'node:path';
import {
  PlannedMigration,
  renderMigrationFile,
} from '../migrations/migration-generator.js';
import { YdbPrimitive } from '../core/types.js';
import { validateIdentifier, validateTableName } from '../core/sql-utils.js';
import { isoDurationToMicroseconds } from '../decorators/ttl.decorator.js';

/** Splits a string into words (by non-alphanumeric and camelCase). */
function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
}

/** Converts a string to PascalCase: splits on non-alphanumeric and camelCase boundaries. */
export function toPascalCase(input: string): string {
  return words(input)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

/** Converts a string to snake_case: splits on non-alphanumeric and camelCase boundaries. */
export function toSnakeCase(input: string): string {
  return words(input)
    .map((w) => w.toLowerCase())
    .join('_');
}

/** Converts a string to kebab-case: splits on non-alphanumeric and camelCase boundaries. */
export function toKebabCase(input: string): string {
  return words(input)
    .map((w) => w.toLowerCase())
    .join('-');
}

/**
 * Ensures a valid TypeScript class identifier (#102): `toPascalCase`
 * on a name without letter words ('123', '---') returns an empty string or
 * a string starting with a digit — such a class won't compile. Valid names
 * are returned unchanged (backward compatibility).
 */
export function toValidClassName(input: string): string {
  const name = toPascalCase(input);
  if (!name || /^[0-9]/.test(name)) return `Migration${name}`;
  return name;
}

/** Result of creating a file on disk. */
export interface CreatedFile {
  filePath: string;
  name: string;
}

function writeFile(dir: string, fileName: string, content: string): string {
  return writeFileAt(path.join(dir, fileName), content);
}

/**
 * Writes a file at an exact path; an existing file is never overwritten.
 *
 * Uses exclusive open (flag 'wx', like entity-diagram.ts):
 * check-then-write via existsSync leaves a race window where another
 * process could slip in an existing file or symlink between check and
 * write, and writeFileSync would silently truncate it. 'wx' does not follow
 * symlinks and atomically fails with EEXIST, guaranteeing one-writer semantics (#170).
 */
function writeFileAt(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'wx');
  } catch (error) {
    // Check by code, not instanceof: in VM environments (jest ESM) a native
    // fs error may not inherit this context's Error.
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new Error(
        `File already exists: ${filePath} — never overwrites existing files.`,
      );
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, content, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
  return filePath;
}

/**
 * Last used timestamp and suffix: protection against migration filename
 * collisions (#102). `Date.now()` has millisecond precision — two generations
 * within the same millisecond (or on a clock jump backward) must get
 * different names, otherwise writeFile fails on an existing file.
 */
let lastTimestamp = 0;
let lastSuffix = 0;

/**
 * Creates a migration file. Without a plan — empty template (migration:create),
 * with a plan — filled DDL (migration:generate).
 *
 * Filename — `<timestamp>-<Name>`; re-generation within the same millisecond
 * gets an anti-collision suffix `-1`, `-2`, ... (#102). Lexicographic
 * sort order of the loader is preserved: all timestamps have the same length,
 * short name (without suffix) comes before longer.
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

/** Creates an entity file (entity:create): `<kebab-name>.entity.ts`. */
export function createEntityFile(dir: string, name: string): CreatedFile {
  return createEntityFileFromSpec(dir, buildDefaultEntitySpec(name));
}

// ---------------------------------------------------------------------------
// Entity generation from spec (#24, interactive entity:create).
// ---------------------------------------------------------------------------

/** Enum column storage (matches YdbEnumMeta.storage). */
export type YdbEnumStorage = 'Utf8' | 'Int32';

/** Description of one column/property of the generated entity. */
export interface YdbEntityColumnSpec {
  /** TS property name; same as the table column name. */
  name: string;
  /** YDB column type (@YdbColumn/@YdbPrimaryColumn). Ignored for encrypted fields. */
  type: YdbPrimitive;
  /** Primary key (@YdbPrimaryColumn). */
  primary?: boolean;
  /** Encrypted field (@YdbEncrypted); column type not declared (always Bytes in DB). */
  encrypted?: boolean;
  /** Blind index for encrypted field (default true, like @YdbEncrypted). */
  blindIndex?: boolean;
  /** Enum column: allowed values (@YdbEnum). */
  enumValues?: readonly string[];
  /** Enum storage: Utf8 (string value) or Int32 (ordinal). */
  enumStorage?: YdbEnumStorage;
  /** Auto-set creation time (@YdbCreateDateColumn). */
  createDate?: boolean;
  /** Auto-set update time (@YdbUpdateDateColumn). */
  updateDate?: boolean;
}

/** Table TTL (@YdbTtl) for a date-like column (Date/Datetime/Timestamp). */
export interface YdbEntityTtlSpec {
  /** ISO 8601 duration, e.g. "PT2H" or "P30D". */
  interval: string;
  /** Date-like column name. */
  column: string;
}

/** Specification of the generated entity. */
export interface YdbEntitySpec {
  className: string;
  tableName: string;
  columns: YdbEntityColumnSpec[];
  ttl?: YdbEntityTtlSpec | null;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names that cannot be used for entity properties: YdbBaseEntity members
 * (Active Record API) and built-in object members. A column with such
 * a name would compile but break the ORM runtime.
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

/** YDB primitives available in entity:create wizard (see core/types.ts). */
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

/** Types for which @YdbCreateDateColumn/@YdbUpdateDateColumn/TTL make sense. */
const DATE_LIKE_TYPES: readonly YdbPrimitive[] = [
  'Date',
  'Datetime',
  'Timestamp',
];

function isDateLike(type: YdbPrimitive): boolean {
  return DATE_LIKE_TYPES.includes(type);
}

/**
 * Validates the entity spec BEFORE writing the file (#24).
 * Returns a list of issues (empty if all is well); file is not written
 * until the list is empty.
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
  // Enum type name is derived from column name: map for collision detection
  // ('foo_bar' and 'fooBar' -> FooBarEnum) — two declarations of the same
  // type don't compile.
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
      // Property becomes both a TS identifier and a SQL column:
      // requirements for both match (ASCII letters/digits/_).
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
        // Member name normalization is lossy ("a-b" and "a_b" -> A_B): duplicates
        // within one enum declaration don't compile (duplicate
        // identifier), so we catch them before writing the file (#24).
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
        // Enum type names are derived from column name too lossy ('foo_bar' and
        // 'fooBar' -> FooBarEnum): two declarations of the same type in a file —
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

/** TS property type corresponding to mapper semantics (core/mapper.ts). */
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

/** TS enum type name for a column ("status" -> StatusEnum, "order_type" -> OrderTypeEnum). */
function enumTypeName(propertyName: string): string {
  const pascal = toPascalCase(propertyName);
  return `${pascal}Enum`;
}

/** String literal in source with single quotes (per .prettierrc style). */
function singleQuoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Enum member name from a string value ("new_order" -> NEW_ORDER). */
export function toEnumMemberName(value: string): string {
  const member = value.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (/^[0-9]/.test(member)) return `V_${member}`;
  return member;
}

/**
 * Renders the entity source in the current public API (@YdbEntity/@YdbColumn/
 * @YdbPrimaryColumn/@YdbEnum/@YdbEncrypted/@YdbTtl/Ydb*-date columns).
 * Formatting matches project .prettierrc (singleQuote, trailingComma).
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

  // Enum declarations come before the class (property types reference them).
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
    // Order matches fixtures/docs:
    // date decorators -> column/PK -> encryption -> enum.
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

/** Entity file path without writing: `<dir>/<kebab-name>.entity.ts`. */
export function entityFilePath(dir: string, name: string): string {
  const kebab = toKebabCase(name);
  const fileName = `${kebab || toPascalCase(name).toLowerCase()}.entity.ts`;
  return path.join(dir, fileName);
}

/**
 * Default spec (non-interactive entity:create path):
 * uuid PK + name — same template as before.
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
 * Valid TS entity class identifier (#102): like toValidClassName,
 * but with Entity prefix instead of Migration (migrations untouched).
 */
export function toValidEntityClassName(input: string): string {
  const name = toPascalCase(input);
  if (!name || /^[0-9]/.test(name)) return `Entity${name}`;
  return name;
}

/**
 * Creates an entity file from a spec: full validation first (#24),
 * then write with protection against overwriting an existing file.
 *
 * `filePath` — explicit path (used by CLI wizard so that pre-check
 * collision and actual write guaranteed point to the same file);
 * by default file name derived from table name.
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
