import { Driver } from '@ydbjs/core';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import {
  TableServiceDefinition,
  CreateSessionResultSchema,
  DescribeTableResultSchema,
  ValueSinceUnixEpochModeSettings_Unit,
} from '@ydbjs/api/table';
import type { TtlSettings } from '@ydbjs/api/table';
import { StatusIds_StatusCode, IssueMessage } from '@ydbjs/api/operation';
import { Type, Type_PrimitiveTypeId } from '@ydbjs/api/value';
import { YdbPrimitive } from '../core/types.js';
import { YdbExecutor } from '../core/interfaces.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import { YdbDevLogger } from '../core/dev-logger.js';
import {
  getYdbEntityMetadata,
  YdbEntityMetadata,
} from '../metadata/entity-metadata.js';
import {
  getManyToManyJoinTables,
  ManyToManyJoinTable,
} from '../decorators/relation.decorators.js';
import {
  BLIND_INDEX_SUFFIX,
  blindIndexColumnName,
} from '../decorators/encryption.decorator.js';
import {
  getYdbIndexesMetadata,
  resolveIndexName,
} from '../decorators/index.decorator.js';
import {
  getYdbTtlMetadata,
  isoDurationToMicrosecondsExact,
  microsecondsToIsoDuration,
  MICROSECONDS_PER_SECOND,
  validateYdbTtlAgainstSchema,
  YdbTtlMetadata,
  YdbTtlUnit,
} from '../decorators/ttl.decorator.js';

/** Expected secondary index of the table. */
export interface ExpectedIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

/**
 * Normalized TTL settings of an existing table
 * (TtlSettings from DescribeTable, see issue #81/#88).
 */
export interface YdbTableTtl {
  column: string;
  /** Delay until expiration in seconds (expire_after_seconds from proto). */
  expireAfterSeconds: number;
  /** Unit of the numeric column; absent for Date/Datetime/Timestamp. */
  unit?: YdbTtlUnit;
}

/**
 * Likely column rename (#23): `from` — an extra column in the DB,
 * `to` — a new entity column. Only a guess based on structural schema
 * signals; never applied automatically.
 */
export interface LikelyRename {
  /** Extra column in the DB (old name). */
  from: string;
  /** Entity column missing in the DB (new name). */
  to: string;
}

/** Expected table schema built from the entity metadata. */
export interface ExpectedTableSchema {
  tableName: string;
  columns: Record<string, YdbPrimitive>;
  primaryKey: string[];
  indexes: ExpectedIndex[];
  ttl?: YdbTtlMetadata;
}

/** Normalized description of an existing table from DescribeTable. */
export interface YdbTableDescription {
  /** Column → primitive typeId (Optional wrapper stripped). */
  columns: Map<string, Type_PrimitiveTypeId>;
  primaryKey: string[];
  /** Indexes described in the DB. */
  indexes?: Array<{ name: string; columns: string[]; unique: boolean }>;
  /**
   * Table TTL settings from DescribeTable (undefined — no TTL set).
   * Compared against @YdbTtl metadata during verify/migrations (#88).
   */
  ttl?: YdbTableTtl;
  /**
   * DB columns with non-primitive types (Decimal/List/Pg, etc.) that
   * cannot be expressed as a typeId (#91): name → human-readable type
   * description. Such columns always count as a type mismatch — but with
   * an honest description of the actual type instead of a meaningless
   * "typeId=0".
   */
  unsupportedColumns?: Map<string, string>;
}

/** Result of checking an existing table against the expected schema. */
export interface SchemaCheckResult {
  tableName: string;
  /** Columns missing in the DB (can be added via ALTER TABLE). */
  missingColumns: [string, YdbPrimitive][];
  /** Columns with a mismatching type (YDB cannot alter a type — manual migration only). */
  typeMismatches: { column: string; expected: YdbPrimitive; actual: string }[];
  /** Extra columns in the DB (not removed automatically — data loss risk). */
  extraColumns: string[];
  /**
   * Likely column renames (#23): exactly one extra DB column and exactly
   * one new entity column with a matching type, not touched by
   * PK/indexes/TTL/blind-index. A diagnostic hint, not a command to act;
   * ADD/DROP and manual migration stay explicit.
   */
  likelyRenames: LikelyRename[];
  primaryKeyMatches: boolean;
  /**
   * Expected PK from the entity metadata — a copy of the input, needed to
   * diagnose order permutations (#89).
   */
  expectedPrimaryKey: string[];
  /** Actual PK from DescribeTable (for order diagnostics, #89). */
  actualPrimaryKey: string[];
  /** Expected PK columns that are absent from the DB PK (#89). */
  missingPrimaryKeyColumns: string[];
  /** DB PK columns not declared as PK in the entity (#89). */
  extraPrimaryKeyColumns: string[];
  /**
   * Pure permutation: the PK column sets match, but the order differs (#89).
   * In YDB the PK column order defines partitioning and range sorting, so
   * [tenant, id] and [id, tenant] are fundamentally different tables.
   */
  primaryKeyOrderMismatch: boolean;
  /** Indexes present in metadata but absent in the DB. */
  missingIndexes: ExpectedIndex[];
  /** Indexes present in the DB but absent in metadata. */
  extraIndexes: Array<{ name: string; columns: string[]; unique: boolean }>;
  /** Indexes with a mismatching unique flag. */
  uniqueMismatches: { name: string; expected: boolean; actual: boolean }[];
  /** Indexes with the same name but a different column list/order. */
  indexColumnsMismatches: {
    name: string;
    expected: string[];
    actual: string[];
  }[];
  /** TTL declared by the entity but not set in the DB. */
  missingTtl: { expected: YdbTtlMetadata }[];
  /** TTL set both in the DB and metadata, but column/unit/interval differ. */
  ttlMismatches: { expected: YdbTtlMetadata; actual: YdbTableTtl }[];
  /** A TTL set in the DB but absent from metadata (not reset automatically). */
  extraTtl: { actual: YdbTableTtl }[];
}

/** A schema problem found during verify. */
export interface YdbSchemaIssue {
  tableName: string;
  kind:
    | 'missing-table'
    | 'missing-column'
    | 'type-mismatch'
    | 'primary-key-mismatch'
    | 'extra-column'
    | 'rename-suggestion'
    | 'missing-index'
    | 'extra-index'
    | 'index-columns-mismatch'
    | 'unique-mismatch'
    | 'ttl-missing'
    | 'ttl-mismatch'
    | 'ttl-extra';
  message: string;
}

/** YdbPrimitive → PrimitiveTypeId (for comparison with DescribeTable). */
const PRIMITIVE_TO_TYPE_ID: Record<YdbPrimitive, Type_PrimitiveTypeId> = {
  Uuid: Type_PrimitiveTypeId.UUID,
  Utf8: Type_PrimitiveTypeId.UTF8,
  Bytes: Type_PrimitiveTypeId.STRING,
  Int32: Type_PrimitiveTypeId.INT32,
  Int64: Type_PrimitiveTypeId.INT64,
  Bool: Type_PrimitiveTypeId.BOOL,
  Double: Type_PrimitiveTypeId.DOUBLE,
  Float: Type_PrimitiveTypeId.FLOAT,
  Date: Type_PrimitiveTypeId.DATE,
  Datetime: Type_PrimitiveTypeId.DATETIME,
  Timestamp: Type_PrimitiveTypeId.TIMESTAMP,
  Json: Type_PrimitiveTypeId.JSON,
  JsonDocument: Type_PrimitiveTypeId.JSON_DOCUMENT,
};

const TYPE_ID_TO_PRIMITIVE = new Map<Type_PrimitiveTypeId, YdbPrimitive>(
  Object.entries(PRIMITIVE_TO_TYPE_ID).map(([k, v]) => [v, k as YdbPrimitive]),
);

/**
 * Numeric TTL column types: YDB allows TTL on Uint32/Uint64/DyNumber
 * with a unit, but these types are not part of YdbPrimitive (the query
 * value mapping does not support them). Here they are needed only for
 * schema comparison so that sync/verify does not treat such a column as
 * a type mismatch (#88).
 */
const TTL_NUMERIC_TYPE_IDS: Record<string, Type_PrimitiveTypeId> = {
  Uint32: Type_PrimitiveTypeId.UINT32,
  Uint64: Type_PrimitiveTypeId.UINT64,
  DyNumber: Type_PrimitiveTypeId.DYNUMBER,
};

for (const [name, typeId] of Object.entries(TTL_NUMERIC_TYPE_IDS)) {
  if (!TYPE_ID_TO_PRIMITIVE.has(typeId)) {
    TYPE_ID_TO_PRIMITIVE.set(typeId, name as YdbPrimitive);
  }
}

/**
 * Issue text unambiguously stating that the path/table does not exist (#91).
 * Only such a SCHEME_ERROR is treated as "no table"; others (access
 * permissions, broken path, etc.) are propagated. Real YDB messages:
 * "path '/db/tbl' does not exist", "Path ... not found".
 */
const NOT_FOUND_ISSUE_RE = /does not exist|not found/i;

/** TtlSettings Unit enum → YdbTtlUnit (see @YdbTtl). */
const TTL_UNIT_BY_PROTO: Record<
  ValueSinceUnixEpochModeSettings_Unit,
  YdbTtlUnit | undefined
> = {
  [ValueSinceUnixEpochModeSettings_Unit.UNSPECIFIED]: undefined,
  [ValueSinceUnixEpochModeSettings_Unit.SECONDS]: 'seconds',
  [ValueSinceUnixEpochModeSettings_Unit.MILLISECONDS]: 'milliseconds',
  [ValueSinceUnixEpochModeSettings_Unit.MICROSECONDS]: 'microseconds',
  [ValueSinceUnixEpochModeSettings_Unit.NANOSECONDS]: 'nanoseconds',
};

/**
 * Builds the expected table schema from the entity metadata:
 * columns plus synthetic {field}_bi blind-index columns.
 * Requires an explicitly declared primary key via @YdbPrimaryColumn.
 *
 * Throws (fail-fast, same policy as for the PK) on invalid TTL metadata:
 * unknown column, incompatible type (YDB allows Date/Datetime/Timestamp
 * or Uint32/Uint64/DyNumber with a unit), unit on a date, or its absence
 * on a number. This way schema sync, migrations and the CLI never generate
 * invalid DDL; at module init the same problems are collected earlier by
 * validateEntityMetadata.
 */
export function buildExpectedTableSchema(
  meta: YdbEntityMetadata,
): ExpectedTableSchema {
  const columns: Record<string, YdbPrimitive> = { ...meta.schema };
  for (const ef of meta.encryptedFields) {
    if (ef.blindIndex) columns[blindIndexColumnName(ef.propertyKey)] = 'Utf8';
  }

  if (meta.primaryKeys.length === 0) {
    throw new Error(
      `Cannot build schema for entity ${meta.target.name}: ` +
        `no primary key is declared. Mark at least one column with @YdbPrimaryColumn.`,
    );
  }

  const primaryKey = [...meta.primaryKeys];

  for (const pk of primaryKey) {
    if (!columns[pk]) {
      throw new Error(
        `Cannot build schema for entity ${meta.target.name}: ` +
          `primary key column "${pk}" is not declared via @YdbColumn. ` +
          `Declare it or mark another column with @YdbPrimaryColumn.`,
      );
    }
  }

  const indexes: ExpectedIndex[] = getYdbIndexesMetadata(meta.target).map(
    (idx) => ({
      name: idx.name ?? resolveIndexName(meta.tableName, idx.columns),
      columns: [...idx.columns],
      unique: idx.unique ?? false,
    }),
  );

  const ttlOptions = getYdbTtlMetadata(meta.target);
  if (ttlOptions) {
    const issues = validateYdbTtlAgainstSchema(
      meta.target.name,
      ttlOptions,
      columns,
    );
    if (issues.length) {
      throw new Error(
        `Cannot build schema for entity ${meta.target.name}: ${issues.join('; ')}`,
      );
    }
  }

  return {
    tableName: meta.tableName,
    columns,
    primaryKey,
    indexes,
    ttl: ttlOptions,
  };
}

/**
 * Expected schema of a many-to-many join table.
 *
 * Column names and types are taken exactly from the definition built by
 * resolveRelationJoinTableDefinition (#90/#87): types are derived from the
 * actual PK metadata of both entities, and an underivable type is a
 * configuration error in the resolver itself. There is no separate type
 * inference path here: the generated schema by construction matches what
 * the relations code reads (see ResolvedJoinTable in entity-relations.ts).
 */
export function buildExpectedJoinTableSchema(
  joinTable: ManyToManyJoinTable,
): ExpectedTableSchema {
  return {
    tableName: joinTable.tableName,
    columns: {
      [joinTable.joinColumn]: joinTable.joinColumnType,
      [joinTable.inverseJoinColumn]: joinTable.inverseJoinColumnType,
    },
    primaryKey: [joinTable.joinColumn, joinTable.inverseJoinColumn],
    indexes: [],
  };
}

/**
 * Collects expected schemas of all entity tables and their many-to-many
 * join tables.
 *
 * The "one table — one expected schema" guarantee (#92):
 *  - a class repeated in the list is deduplicated;
 *  - a class without its own @YdbEntity is skipped (not an entity — see
 *    getYdbEntityMetadata), so a subclass does not produce a second schema
 *    for the parent's table;
 *  - two different entities with the same tableName is an error: otherwise
 *    sync would patch one table with two different schemas and verify would
 *    emit contradictory issues. The collision is detected here — before any
 *    DB access.
 */
export function buildExpectedSchemas(
  entities: (new (...args: any[]) => any)[],
): ExpectedTableSchema[] {
  const schemas: ExpectedTableSchema[] = [];
  const seenEntities = new Set<new (...args: any[]) => any>();
  const tableOwners = new Map<string, new (...args: any[]) => any>();

  for (const entity of entities) {
    if (seenEntities.has(entity)) continue;
    seenEntities.add(entity);

    const meta = getYdbEntityMetadata(entity);
    if (!meta) continue;

    const owner = tableOwners.get(meta.tableName);
    if (owner && owner !== entity) {
      throw new Error(
        `Duplicate table name "${meta.tableName}": entities ${owner.name} ` +
          `and ${entity.name} both map to it — each entity class must declare ` +
          `its own table via @YdbEntity (a subclass without its own ` +
          `@YdbEntity is not an entity and must not be passed as one).`,
      );
    }
    tableOwners.set(meta.tableName, entity);

    schemas.push(buildExpectedTableSchema(meta));
  }

  for (const joinTable of getManyToManyJoinTables([...seenEntities])) {
    schemas.push(buildExpectedJoinTableSchema(joinTable));
  }

  return schemas;
}

/**
 * Generates the WITH (...) TTL clause for CREATE TABLE.
 * In YQL syntax the TTL is specified only in WITH, not inside the table body:
 *   WITH (TTL = Interval("PT2H") ON `col` [AS SECONDS])
 */
export function generateTtlWithClause(ttl: YdbTtlMetadata): string {
  return `WITH (\n  ${ttlExpression(ttl)}\n)`;
}

/** Generates the CREATE TABLE DDL. */
export function generateCreateTableYql(expected: ExpectedTableSchema): string {
  const columnDefs = Object.entries(expected.columns).map(
    ([name, type]) => `${quoteIdentifier(name)} ${type}`,
  );
  const indexDefs = (expected.indexes ?? []).map(
    (idx) =>
      `${idx.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(idx.name)} GLOBAL SYNC ON ` +
      `(${idx.columns.map(quoteIdentifier).join(', ')})`,
  );
  const pk = expected.primaryKey.map(quoteIdentifier).join(', ');
  const parts = [...columnDefs, ...indexDefs, `PRIMARY KEY (${pk})`];
  const body = parts.join(',\n  ');
  let yql =
    `CREATE TABLE ${quoteIdentifier(expected.tableName)} (\n  ` + `${body}\n)`;
  if (expected.ttl) {
    yql += `\n${generateTtlWithClause(expected.ttl)}`;
  }
  return yql;
}

/** Generates DDL to add missing columns (one ALTER per table). */
export function generateAddColumnsYql(
  tableName: string,
  columns: [string, YdbPrimitive][],
): string {
  const clauses = columns.map(
    ([name, type]) => `ADD COLUMN ${quoteIdentifier(name)} ${type}`,
  );
  return `ALTER TABLE ${quoteIdentifier(tableName)} ${clauses.join(', ')}`;
}

/** Generates DDL to add an index via ALTER TABLE. */
export function generateAddIndexYql(
  tableName: string,
  index: ExpectedIndex,
): string {
  const uniquePart = index.unique ? 'UNIQUE ' : '';
  return (
    `ALTER TABLE ${quoteIdentifier(tableName)} ` +
    `ADD ${uniquePart}INDEX ${quoteIdentifier(index.name)} GLOBAL SYNC ON ` +
    `(${index.columns.map(quoteIdentifier).join(', ')})`
  );
}

/** Generates DDL to drop an index via ALTER TABLE. */
export function generateDropIndexYql(
  tableName: string,
  indexName: string,
): string {
  return (
    `ALTER TABLE ${quoteIdentifier(tableName)} ` +
    `DROP INDEX ${quoteIdentifier(indexName)}`
  );
}

/**
 * Generates DDL to set/replace TTL via ALTER TABLE.
 * The TTL expression matches the WITH clause of CREATE TABLE (#81):
 *   ALTER TABLE `t` SET (TTL = Interval("PT2H") ON `col` [AS SECONDS])
 */
export function generateSetTtlYql(
  tableName: string,
  ttl: YdbTtlMetadata,
): string {
  return `ALTER TABLE ${quoteIdentifier(tableName)} SET (${ttlExpression(ttl)})`;
}

/** Generates DDL to reset TTL: ALTER TABLE `t` RESET (TTL). */
export function generateResetTtlYql(tableName: string): string {
  return `ALTER TABLE ${quoteIdentifier(tableName)} RESET (TTL)`;
}

/** The `TTL = Interval(...) ON col [AS unit]` expression, shared by CREATE/ALTER. */
function ttlExpression(ttl: YdbTtlMetadata): string {
  const unitPart = ttl.unit ? ` AS ${ttl.unit.toUpperCase()}` : '';
  return `TTL = Interval("${ttl.interval}") ON ${quoteIdentifier(ttl.column)}${unitPart}`;
}

/** Human-readable representation of the expected TTL (for issues/warnings). */
function formatTtlMeta(ttl: YdbTtlMetadata): string {
  const unitPart = ttl.unit ? ` AS ${ttl.unit.toUpperCase()}` : '';
  return `${ttl.interval} on column "${ttl.column}"${unitPart}`;
}

/** Human-readable representation of the actual TTL from the DB. */
function formatTableTtl(ttl: YdbTableTtl): string {
  const unitPart = ttl.unit ? ` AS ${ttl.unit.toUpperCase()}` : '';
  return (
    `${microsecondsToIsoDuration(ttl.expireAfterSeconds * MICROSECONDS_PER_SECOND)} ` +
    `on column "${ttl.column}"${unitPart}`
  );
}

/**
 * Compares the expected TTL with the actual one from DescribeTable:
 * column, unit and interval. The interval is compared semantically in whole
 * microseconds (YDB Interval's internal precision): "PT1H" and "PT60M"
 * are equal, "PT0.5S" is exactly 500000µs, without float loss.
 * Intervals that cannot be represented exactly in a YDB Interval — calendar
 * parts and fractions finer than microseconds — count as a mismatch so that
 * migration or sync sets the value from metadata instead of a false "match"
 * after truncation.
 */
function ttlSettingsMatch(
  expected: YdbTtlMetadata,
  actual: YdbTableTtl,
): boolean {
  if (expected.column !== actual.column) return false;
  if ((expected.unit ?? undefined) !== (actual.unit ?? undefined)) return false;
  const expectedMicros = isoDurationToMicrosecondsExact(expected.interval);
  return (
    expectedMicros !== null &&
    expectedMicros === actual.expireAfterSeconds * MICROSECONDS_PER_SECOND
  );
}

/**
 * Detects a likely column rename (#23).
 *
 * A conservative heuristic based on structural schema signals, without
 * comparing name similarity. A hint is emitted only when ALL conditions hold:
 *  - the DB has exactly one extra column (`from`) and the entity exactly one
 *    new one (`to`) — an unambiguous match with no candidates to choose from;
 *  - the primitive type of `to` equals the actual type of `from` in the DB
 *    (implicitly unsupported type columns, #91, are filtered immediately);
 *  - neither `from` nor `to` participates in the PK;
 *  - neither `from` nor `to` appears in index columns (actual and expected) —
 *    otherwise it is an index change, not a rename;
 *  - neither `from` nor `to` is a TTL column (actual or expected);
 *  - the mismatch does not involve a blind index: both columns are not
 *    synthetic `_bi` (BLIND_INDEX_SUFFIX) and each has no `_bi` partner in
 *    its own schema.
 *
 * Any mismatch returns an empty list — the regular ADD/DROP and manual
 * migration warnings remain.
 */
function detectLikelyRenames(
  expected: ExpectedTableSchema,
  existing: YdbTableDescription,
  missingColumns: [string, YdbPrimitive][],
  extraColumns: string[],
): LikelyRename[] {
  if (missingColumns.length !== 1 || extraColumns.length !== 1) return [];

  const from = extraColumns[0];
  const [to, toType] = missingColumns[0];

  // Type match: the necessary condition for "it is the same column".
  const actualTypeId = existing.columns.get(from);
  if (
    actualTypeId === undefined ||
    PRIMITIVE_TO_TYPE_ID[toType] !== actualTypeId
  ) {
    return [];
  }

  // PK: renaming a key column in YDB is impossible — manual migration only.
  if (existing.primaryKey.includes(from) || expected.primaryKey.includes(to)) {
    return [];
  }

  // Indexes: an index mismatch around the pair is an index change,
  // not a plain rename.
  const referencedByIndex = (columnsList: string[][], name: string) =>
    columnsList.some((cols) => cols.includes(name));
  if (
    referencedByIndex(
      (existing.indexes ?? []).map((idx) => idx.columns),
      from,
    ) ||
    referencedByIndex(
      (expected.indexes ?? []).map((idx) => idx.columns),
      to,
    )
  ) {
    return [];
  }

  // TTL: moving a TTL column is a TTL settings change, not a plain rename.
  if (existing.ttl?.column === from || expected.ttl?.column === to) return [];

  // Blind index/encryption: a synthetic column or the appearance/disappearance
  // of its `_bi` partner means an encryption metadata change.
  if (from.endsWith(BLIND_INDEX_SUFFIX) || to.endsWith(BLIND_INDEX_SUFFIX)) {
    return [];
  }
  if (
    existing.columns.has(`${from}${BLIND_INDEX_SUFFIX}`) ||
    `${to}${BLIND_INDEX_SUFFIX}` in expected.columns
  ) {
    return [];
  }

  return [{ from, to }];
}

/**
 * Pure check: compares the expected schema with the DB table description.
 * Makes no network calls and changes nothing.
 */
export function checkTableSchema(
  expected: ExpectedTableSchema,
  existing: YdbTableDescription,
): SchemaCheckResult {
  const missingColumns: [string, YdbPrimitive][] = [];
  const typeMismatches: SchemaCheckResult['typeMismatches'] = [];
  const unsupportedColumns = existing.unsupportedColumns;

  for (const [name, type] of Object.entries(expected.columns)) {
    // Non-primitive type in the DB (#91): typeId comparison is impossible —
    // report the mismatch with the actual type (decimal(22,9), list<...>)
    // instead of a meaningless typeId=0.
    const actualUnsupported = unsupportedColumns?.get(name);
    if (actualUnsupported !== undefined) {
      typeMismatches.push({
        column: name,
        expected: type,
        actual: actualUnsupported,
      });
      continue;
    }
    const actualTypeId = existing.columns.get(name);
    if (actualTypeId === undefined) {
      missingColumns.push([name, type]);
      continue;
    }
    // Numeric TTL types (Uint32/Uint64/DyNumber) are not part of YdbPrimitive
    // but are valid for schema comparison — see TTL_NUMERIC_TYPE_IDS.
    const expectedTypeId =
      PRIMITIVE_TO_TYPE_ID[type] ?? TTL_NUMERIC_TYPE_IDS[type];
    if (actualTypeId !== expectedTypeId) {
      typeMismatches.push({
        column: name,
        expected: type,
        actual:
          TYPE_ID_TO_PRIMITIVE.get(actualTypeId) ?? `typeId=${actualTypeId}`,
      });
    }
  }

  const expectedColumns = new Set(Object.keys(expected.columns));
  // A DB column lives either in columns or in unsupportedColumns — but
  // descriptions may come from external code, so we deduplicate.
  const extraColumns = [
    ...existing.columns.keys(),
    ...(unsupportedColumns?.keys() ?? []),
  ].filter((name) => !expectedColumns.has(name));
  const uniqueExtraColumns = [...new Set(extraColumns)];

  // PK column order matters (#89): in YDB it defines partitioning and range
  // sorting, so [tenant, id] and [id, tenant] are different tables.
  // Compare element-wise, never as a set.
  const primaryKeyMatches =
    expected.primaryKey.length === existing.primaryKey.length &&
    expected.primaryKey.every((pk, i) => existing.primaryKey[i] === pk);
  const missingPrimaryKeyColumns = expected.primaryKey.filter(
    (pk) => !existing.primaryKey.includes(pk),
  );
  const extraPrimaryKeyColumns = existing.primaryKey.filter(
    (pk) => !expected.primaryKey.includes(pk),
  );
  // Pure permutation: the sets are equal, the order differs. If there are
  // missing or extra PK columns, that case is already covered by their lists.
  const primaryKeyOrderMismatch =
    !primaryKeyMatches &&
    missingPrimaryKeyColumns.length === 0 &&
    extraPrimaryKeyColumns.length === 0;

  const existingIndexes = existing.indexes ?? [];

  const existingIndexMap = new Map(
    existingIndexes.map((idx) => [idx.name, idx]),
  );
  const expectedIndexMap = new Map(
    (expected.indexes ?? []).map((idx) => [idx.name, idx]),
  );

  const missingIndexes: ExpectedIndex[] = (expected.indexes ?? []).filter(
    (idx) => !existingIndexMap.has(idx.name),
  );

  const extraIndexes = existingIndexes.filter(
    (idx) => !expectedIndexMap.has(idx.name),
  );

  const uniqueMismatches: SchemaCheckResult['uniqueMismatches'] = [];
  const indexColumnsMismatches: SchemaCheckResult['indexColumnsMismatches'] =
    [];
  for (const idx of expected.indexes ?? []) {
    const existingIdx = existingIndexMap.get(idx.name);
    if (!existingIdx) continue;
    if (existingIdx.unique !== idx.unique) {
      uniqueMismatches.push({
        name: idx.name,
        expected: idx.unique,
        actual: existingIdx.unique,
      });
    }
    // Columns are compared in order: in YDB the index column order is
    // significant (prefix search) and cannot be changed — only the index
    // can be recreated.
    if (
      existingIdx.columns.length !== idx.columns.length ||
      existingIdx.columns.some((col, i) => col !== idx.columns[i])
    ) {
      indexColumnsMismatches.push({
        name: idx.name,
        expected: [...idx.columns],
        actual: [...existingIdx.columns],
      });
    }
  }

  // TTL (#88): missing, changed and extra — a DB TTL either matches @YdbTtl
  // or is not present at all.
  const missingTtl: SchemaCheckResult['missingTtl'] = [];
  const ttlMismatches: SchemaCheckResult['ttlMismatches'] = [];
  const extraTtl: SchemaCheckResult['extraTtl'] = [];

  if (expected.ttl && !existing.ttl) {
    missingTtl.push({ expected: expected.ttl });
  } else if (!expected.ttl && existing.ttl) {
    extraTtl.push({ actual: existing.ttl });
  } else if (
    expected.ttl &&
    existing.ttl &&
    !ttlSettingsMatch(expected.ttl, existing.ttl)
  ) {
    ttlMismatches.push({ expected: expected.ttl, actual: existing.ttl });
  }

  return {
    tableName: expected.tableName,
    missingColumns,
    typeMismatches,
    extraColumns: uniqueExtraColumns,
    likelyRenames: detectLikelyRenames(
      expected,
      existing,
      missingColumns,
      uniqueExtraColumns,
    ),
    primaryKeyMatches,
    expectedPrimaryKey: [...expected.primaryKey],
    actualPrimaryKey: [...existing.primaryKey],
    missingPrimaryKeyColumns,
    extraPrimaryKeyColumns,
    primaryKeyOrderMismatch,
    missingIndexes,
    extraIndexes,
    uniqueMismatches,
    indexColumnsMismatches,
    missingTtl,
    ttlMismatches,
    extraTtl,
  };
}

/**
 * Human-readable description of a primary key mismatch (#89):
 * distinguishes a pure PK column permutation (order matters in YDB) from
 * missing/extra PK columns. Used in verify/diffSchemas issues and in
 * migration plan warnings.
 */
export function describePrimaryKeyMismatch(check: SchemaCheckResult): string {
  if (check.primaryKeyOrderMismatch) {
    return (
      'primary key column order mismatch: ' +
      `expected [${check.expectedPrimaryKey.join(', ')}], ` +
      `actual [${check.actualPrimaryKey.join(', ')}]`
    );
  }
  const parts: string[] = [];
  if (check.missingPrimaryKeyColumns.length) {
    parts.push(`missing [${check.missingPrimaryKeyColumns.join(', ')}]`);
  }
  if (check.extraPrimaryKeyColumns.length) {
    parts.push(`unexpected [${check.extraPrimaryKeyColumns.join(', ')}]`);
  }
  return parts.length
    ? `primary key mismatch (${parts.join(', ')})`
    : 'primary key mismatch';
}

/**
 * Turns a table check result into a flat list of issues.
 * Used by both `YdbSchemaSyncer.verify` and the CLI (pretty diff).
 */
export function checkToIssues(check: SchemaCheckResult): YdbSchemaIssue[] {
  const issues: YdbSchemaIssue[] = [];

  if (!check.primaryKeyMatches) {
    issues.push({
      tableName: check.tableName,
      kind: 'primary-key-mismatch',
      message: `Table "${check.tableName}" ${describePrimaryKeyMismatch(check)}`,
    });
  }
  for (const [column] of check.missingColumns) {
    issues.push({
      tableName: check.tableName,
      kind: 'missing-column',
      message: `Table "${check.tableName}" is missing column "${column}"`,
    });
  }
  for (const m of check.typeMismatches) {
    issues.push({
      tableName: check.tableName,
      kind: 'type-mismatch',
      message:
        `Table "${check.tableName}" column "${m.column}" type mismatch: ` +
        `expected ${m.expected}, actual ${m.actual}`,
    });
  }
  for (const column of check.extraColumns) {
    issues.push({
      tableName: check.tableName,
      kind: 'extra-column',
      message: `Table "${check.tableName}" has extra column "${column}"`,
    });
  }
  // #23: the likely-rename hint is informational — it does not fix the
  // schema by itself (the column is still missing in the DB), so the
  // mismatch remains in both verify and diffSchemas.
  for (const rename of check.likelyRenames) {
    issues.push({
      tableName: check.tableName,
      kind: 'rename-suggestion',
      message:
        `Table "${check.tableName}" column "${rename.from}" may have been renamed to ` +
        `"${rename.to}" — review the data before migrating manually`,
    });
  }
  for (const idx of check.missingIndexes) {
    issues.push({
      tableName: check.tableName,
      kind: 'missing-index',
      message: `Table "${check.tableName}" is missing index "${idx.name}"`,
    });
  }
  for (const idx of check.extraIndexes) {
    issues.push({
      tableName: check.tableName,
      kind: 'extra-index',
      message: `Table "${check.tableName}" has extra index "${idx.name}"`,
    });
  }
  for (const m of check.indexColumnsMismatches) {
    issues.push({
      tableName: check.tableName,
      kind: 'index-columns-mismatch',
      message:
        `Table "${check.tableName}" index "${m.name}" columns mismatch: ` +
        `expected [${m.expected.join(', ')}], actual [${m.actual.join(', ')}]`,
    });
  }
  for (const m of check.uniqueMismatches) {
    issues.push({
      tableName: check.tableName,
      kind: 'unique-mismatch',
      message:
        `Table "${check.tableName}" index "${m.name}" unique flag mismatch: ` +
        `expected ${m.expected}, actual ${m.actual}`,
    });
  }
  for (const m of check.missingTtl) {
    issues.push({
      tableName: check.tableName,
      kind: 'ttl-missing',
      message:
        `Table "${check.tableName}" has no TTL, entity declares ` +
        formatTtlMeta(m.expected),
    });
  }
  for (const m of check.ttlMismatches) {
    issues.push({
      tableName: check.tableName,
      kind: 'ttl-mismatch',
      message:
        `Table "${check.tableName}" TTL mismatch: expected ` +
        `${formatTtlMeta(m.expected)}, actual ${formatTableTtl(m.actual)}`,
    });
  }
  for (const m of check.extraTtl) {
    issues.push({
      tableName: check.tableName,
      kind: 'ttl-extra',
      message:
        `Table "${check.tableName}" has TTL ${formatTableTtl(m.actual)} ` +
        `not present in entity`,
    });
  }

  return issues;
}

/**
 * Pure diff of the expected schemas against the current DB state
 * (null — table does not exist). Makes no network calls. Used by the CLI
 * for human-readable mismatch output.
 */
export function diffSchemas(
  expected: ExpectedTableSchema[],
  existing: (YdbTableDescription | null)[],
): YdbSchemaIssue[] {
  const issues: YdbSchemaIssue[] = [];
  for (let i = 0; i < expected.length; i++) {
    const schema = expected[i];
    const current = existing[i];
    if (!current) {
      issues.push({
        tableName: schema.tableName,
        kind: 'missing-table',
        message: `Table "${schema.tableName}" does not exist`,
      });
      continue;
    }
    issues.push(...checkToIssues(checkTableSchema(schema, current)));
  }
  return issues;
}

/**
 * DB schema synchronizer: creates missing tables and columns from the
 * entity metadata. Changing a column type or primary key is impossible in
 * YDB — such mismatches result in an error.
 */
export class YdbSchemaSyncer {
  private readonly logger = new YdbDevLogger(YdbSchemaSyncer.name);

  constructor(
    private readonly driver: Driver,
    private readonly executor: YdbExecutor,
  ) {}

  /**
   * Checks the DB schema against the entity metadata without changing anything.
   * Returns the list of mismatches found.
   */
  async verify(
    entities: (new (...args: any[]) => any)[],
  ): Promise<YdbSchemaIssue[]> {
    const issues: YdbSchemaIssue[] = [];

    for (const expected of buildExpectedSchemas(entities)) {
      const existing = await this.describeTable(expected.tableName);
      if (!existing) {
        issues.push({
          tableName: expected.tableName,
          kind: 'missing-table',
          message: `Table "${expected.tableName}" does not exist`,
        });
        continue;
      }

      issues.push(...this.checkToIssues(checkTableSchema(expected, existing)));
    }

    return issues;
  }

  /**
   * Aligns the DB with the entity schema:
   *  - no table — CREATE TABLE;
   *  - missing columns — ALTER TABLE ADD COLUMN;
   *  - missing indexes — ALTER TABLE ADD INDEX;
   *  - no TTL or TTL differing from metadata — ALTER TABLE SET (TTL = ...)
   *    (SET overwrites existing settings);
   *  - extra columns/indexes/TTL — only a warning to the log
   *    (we do not delete data or settings);
   *  - type/PK/index-column mismatch — error (immutable in YDB,
   *    a migration is required).
   */
  async sync(entities: (new (...args: any[]) => any)[]): Promise<void> {
    for (const expected of buildExpectedSchemas(entities)) {
      const existing = await this.describeTable(expected.tableName);

      if (!existing) {
        const yql = generateCreateTableYql(expected);
        this.logger.log(`Creating table "${expected.tableName}"`);
        await this.executeDdl(yql);
        continue;
      }

      const check = checkTableSchema(expected, existing);

      if (!check.primaryKeyMatches) {
        throw new Error(
          `Schema sync failed for table "${expected.tableName}": ` +
            `primary key mismatch (expected [${expected.primaryKey.join(', ')}], ` +
            `actual [${existing.primaryKey.join(', ')}]). ` +
            `YDB cannot alter a primary key — migrate the table manually.`,
        );
      }

      if (check.typeMismatches.length) {
        const details = check.typeMismatches
          .map((m) => `${m.column}: expected ${m.expected}, actual ${m.actual}`)
          .join('; ');
        throw new Error(
          `Schema sync failed for table "${expected.tableName}": ` +
            `column type mismatch (${details}). ` +
            `YDB cannot alter a column type — migrate the table manually.`,
        );
      }

      if (check.indexColumnsMismatches.length) {
        const details = check.indexColumnsMismatches
          .map(
            (m) =>
              `${m.name}: expected [${m.expected.join(', ')}], ` +
              `actual [${m.actual.join(', ')}]`,
          )
          .join('; ');
        throw new Error(
          `Schema sync failed for table "${expected.tableName}": ` +
            `index columns mismatch (${details}). ` +
            `YDB cannot alter index columns — drop and recreate the index manually.`,
        );
      }

      for (const extra of check.extraColumns) {
        this.logger.warn(
          `Table "${expected.tableName}" has extra column "${extra}" ` +
            `not present in entity ${expected.tableName} — left as is`,
        );
      }

      // #23: a rename is never applied automatically — sync still adds the
      // new column and leaves the old one untouched.
      for (const rename of check.likelyRenames) {
        this.logger.warn(
          `Table "${expected.tableName}" column "${rename.from}" may have been ` +
            `renamed to "${rename.to}" — adding "${rename.to}", keeping ` +
            `"${rename.from}"; rename/copy the data manually if confirmed`,
        );
      }

      if (check.missingColumns.length) {
        const yql = generateAddColumnsYql(
          expected.tableName,
          check.missingColumns,
        );
        this.logger.log(
          `Adding columns to "${expected.tableName}": ` +
            check.missingColumns.map(([name]) => name).join(', '),
        );
        await this.executeDdl(yql);
      }

      for (const extra of check.extraIndexes) {
        this.logger.warn(
          `Table "${expected.tableName}" has extra index "${extra.name}" ` +
            `not present in entity — left as is`,
        );
      }

      for (const idx of check.missingIndexes) {
        const yql = generateAddIndexYql(expected.tableName, idx);
        this.logger.log(
          `Adding index "${idx.name}" to "${expected.tableName}"`,
        );
        await this.executeDdl(yql);
      }

      for (const m of check.uniqueMismatches) {
        this.logger.warn(
          `Table "${expected.tableName}" index "${m.name}" unique flag mismatch: ` +
            `expected ${m.expected}, actual ${m.actual} — recreate index manually if needed`,
        );
      }

      // TTL: missing is set, changed is replaced — SET (TTL = ...)
      // overwrites existing settings. An extra TTL is not reset
      // automatically: same policy as in planMigration (#88).
      if (check.missingTtl.length && check.missingTtl[0].expected) {
        this.logger.log(
          `Setting TTL on "${expected.tableName}" ` +
            `(column "${check.missingTtl[0].expected.column}")`,
        );
        await this.executeDdl(
          generateSetTtlYql(expected.tableName, check.missingTtl[0].expected),
        );
      }

      for (const m of check.ttlMismatches) {
        this.logger.log(
          `Updating TTL on "${expected.tableName}" ` +
            `(was ${formatTableTtl(m.actual)})`,
        );
        await this.executeDdl(
          generateSetTtlYql(expected.tableName, m.expected),
        );
      }

      for (const extra of check.extraTtl) {
        this.logger.warn(
          `Table "${expected.tableName}" has extra TTL on column ` +
            `"${extra.actual.column}" — left as is`,
        );
      }
    }
  }

  private checkToIssues(check: SchemaCheckResult): YdbSchemaIssue[] {
    return checkToIssues(check);
  }

  private async executeDdl(yql: string): Promise<void> {
    await this.executor([yql] as unknown as TemplateStringsArray);
  }

  /**
   * DescribeTable via the Table service (the query service does not return
   * column metadata). A session is created per call and closed immediately.
   *
   * Returns null only when the table genuinely does not exist (#91): a
   * distinct NOT_FOUND status or a SCHEME_ERROR whose issues explicitly state
   * that the path/table does not exist. Any other SCHEME_ERROR (no
   * permissions, broken path, etc.) is propagated with context — previously
   * it also became null, causing sync to CREATE TABLE an existing table and
   * verify to report a false missing-table.
   * Public: also used by the migration generator (migration:generate).
   */
  async describeTable(tableName: string): Promise<YdbTableDescription | null> {
    const client = this.driver.createClient(TableServiceDefinition);
    const path = `${this.driver.database.replace(/\/$/, '')}/${tableName}`;

    const session = await client.createSession({});
    const sessionResult = session.operation?.result
      ? anyUnpack(session.operation.result, CreateSessionResultSchema)
      : undefined;
    const sessionId = sessionResult?.sessionId;
    if (!sessionId) {
      throw new Error('Failed to create YDB table session for schema sync');
    }

    try {
      const response = await client.describeTable({ sessionId, path });
      const operation = response.operation;

      if (!operation || operation.status !== StatusIds_StatusCode.SUCCESS) {
        const issueText = this.formatIssues(operation?.issues);
        const notFound =
          operation?.status === StatusIds_StatusCode.NOT_FOUND ||
          (operation?.status === StatusIds_StatusCode.SCHEME_ERROR &&
            NOT_FOUND_ISSUE_RE.test(issueText));
        if (notFound) return null;

        const statusName = operation
          ? (StatusIds_StatusCode[operation.status] ?? operation.status)
          : 'unknown';
        throw new Error(
          `DescribeTable failed for "${path}": ` +
            `status=${statusName}` +
            (issueText ? `; ${issueText}` : ' (no issues reported)'),
        );
      }

      const result = operation.result
        ? anyUnpack(operation.result, DescribeTableResultSchema)
        : undefined;
      if (!result) {
        throw new Error(`DescribeTable returned no result for "${path}"`);
      }

      // Columns with non-primitive types (Decimal/List/Pg, etc.) cannot be
      // expressed as a typeId — they go into unsupportedColumns with an
      // honest type description instead of a meaningless typeId=0 (#91).
      const columns = new Map<string, Type_PrimitiveTypeId>();
      const unsupportedColumns = new Map<string, string>();
      for (const column of result.columns) {
        const typeId = this.extractPrimitiveTypeId(column.type);
        if (typeId === null) {
          unsupportedColumns.set(column.name, this.formatYdbType(column.type));
          continue;
        }
        columns.set(column.name, typeId);
      }

      const indexes = result.indexes.map((idx) => ({
        name: idx.name,
        columns: [...idx.indexColumns],
        unique: idx.type.case === 'globalUniqueIndex',
      }));

      return {
        columns,
        primaryKey: [...result.primaryKey],
        indexes,
        ttl: this.extractTtl(result.ttlSettings),
        ...(unsupportedColumns.size ? { unsupportedColumns } : {}),
      };
    } finally {
      await client.deleteSession({ sessionId }).catch((error: unknown) => {
        this.logger.warn(
          `Failed to delete YDB table session: ${(error as Error).message}`,
        );
      });
    }
  }

  /**
   * Strips Optional wrappers and returns the primitive typeId.
   * null — the type is non-primitive (Decimal/List/Pg/...): it cannot be
   * compared by typeId, the actual description goes to unsupportedColumns (#91)
   * instead of a meaningless PRIMITIVE_TYPE_ID_UNSPECIFIED (=0).
   */
  private extractPrimitiveTypeId(type?: Type): Type_PrimitiveTypeId | null {
    let current = type;
    while (current?.type.case === 'optionalType') {
      current = current.type.value.item;
    }
    if (current?.type.case === 'typeId') {
      return current.type.value;
    }
    return null;
  }

  /**
   * Compact human-readable type description from DescribeTable (#91):
   * decimal(22,9), list<utf8>, pg<int4>, etc. Used in type mismatch
   * messages instead of a meaningless "typeId=0".
   */
  private formatYdbType(type?: Type): string {
    let current = type;
    let optional = false;
    while (current?.type.case === 'optionalType') {
      current = current.type.value.item;
      optional = true;
    }

    const inner = this.formatNonOptionalYdbType(current);
    return optional ? `${inner}?` : inner;
  }

  private formatNonOptionalYdbType(type?: Type): string {
    const t = type?.type;
    switch (t?.case) {
      case 'typeId': {
        const name =
          TYPE_ID_TO_PRIMITIVE.get(t.value) ?? Type_PrimitiveTypeId[t.value];
        return name ? name.toLowerCase() : `typeId=${t.value}`;
      }
      case 'decimalType':
        return `decimal(${t.value.precision},${t.value.scale})`;
      case 'listType':
        return `list<${this.formatYdbType(t.value.item)}>`;
      case 'tupleType':
        return `tuple<${t.value.elements.map((i) => this.formatYdbType(i)).join(', ')}>`;
      case 'dictType':
        return (
          `dict<${this.formatYdbType(t.value.key)}, ` +
          `${this.formatYdbType(t.value.payload)}>`
        );
      case 'structType':
        return `struct<${t.value.members
          .map((m) => `${m.name}: ${this.formatYdbType(m.type)}`)
          .join(', ')}>`;
      case 'pgType':
        return t.value.typeName
          ? `pg<${t.value.typeName}>`
          : `pg(oid=${t.value.oid})`;
      default:
        // variantType/taggedType/voidType/... — the proto-case name already
        // carries the actual type information.
        return t?.case ?? 'unknown';
    }
  }

  /**
   * Normalizes TtlSettings from DescribeTable into YdbTableTtl.
   * The date mode (dateTypeColumn) has no unit; the numeric mode
   * (valueSinceUnixEpoch) maps the Unit enum to YdbTtlUnit, and UNSPECIFIED
   * is treated as no unit.
   */
  private extractTtl(settings?: TtlSettings): YdbTableTtl | undefined {
    const mode = settings?.mode;
    if (!mode?.case) return undefined;

    if (mode.case === 'dateTypeColumn') {
      return {
        column: mode.value.columnName,
        expireAfterSeconds: mode.value.expireAfterSeconds,
      };
    }

    const { columnName, columnUnit, expireAfterSeconds } = mode.value;
    return {
      column: columnName,
      expireAfterSeconds,
      ...(columnUnit !== ValueSinceUnixEpochModeSettings_Unit.UNSPECIFIED
        ? { unit: TTL_UNIT_BY_PROTO[columnUnit] }
        : {}),
    };
  }

  private formatIssues(issues?: IssueMessage[]): string {
    if (!issues?.length) return '';
    const flatten = (list: IssueMessage[]): string[] =>
      list.flatMap((i) => [i.message, ...flatten(i.issues)]);
    return flatten(issues).filter(Boolean).join('; ');
  }
}
