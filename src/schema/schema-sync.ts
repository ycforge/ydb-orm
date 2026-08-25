import { Logger } from '@nestjs/common';
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

/** Ожидаемый вторичный индекс таблицы. */
export interface ExpectedIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

/**
 * Нормализованные TTL-настройки существующей таблицы
 * (TtlSettings из DescribeTable, см. issue #81/#88).
 */
export interface YdbTableTtl {
  column: string;
  /** Задержка до истечения в секундах (expire_after_seconds из proto). */
  expireAfterSeconds: number;
  /** Единица числовой колонки; отсутствует для Date/Datetime/Timestamp. */
  unit?: YdbTtlUnit;
}

/**
 * Вероятное переименование колонки (#23): `from` — лишняя колонка в БД,
 * `to` — новая колонка сущности. Только предположение по структурным
 * признакам схемы; никогда не применяется автоматически.
 */
export interface LikelyRename {
  /** Лишняя колонка в БД (старое имя). */
  from: string;
  /** Отсутствующая в БД колонка сущности (новое имя). */
  to: string;
}

/** Ожидаемая схема таблицы, построенная по метаданным сущности. */
export interface ExpectedTableSchema {
  tableName: string;
  columns: Record<string, YdbPrimitive>;
  primaryKey: string[];
  indexes: ExpectedIndex[];
  ttl?: YdbTtlMetadata;
}

/** Нормализованное описание существующей таблицы из DescribeTable. */
export interface YdbTableDescription {
  /** Колонка → примитивный typeId (Optional обёртка снята). */
  columns: Map<string, Type_PrimitiveTypeId>;
  primaryKey: string[];
  /** Индексы, описанные в БД. */
  indexes?: Array<{ name: string; columns: string[]; unique: boolean }>;
  /**
   * TTL-настройки таблицы из DescribeTable (undefined — TTL не задан).
   * Сравнивается с метаданными @YdbTtl при verify/миграциях (#88).
   */
  ttl?: YdbTableTtl;
  /**
   * Колонки БД с не-примитивными типами (Decimal/List/Pg и т.п.), которые
   * нельзя выразить typeId (#91): имя → человекочитаемое описание типа.
   * Такие колонки всегда считаются расхождением типов — но с честным
   * описанием фактического типа вместо бессмысленного «typeId=0».
   */
  unsupportedColumns?: Map<string, string>;
}

/** Результат проверки существующей таблицы против ожидаемой схемы. */
export interface SchemaCheckResult {
  tableName: string;
  /** Колонки, которых нет в БД (можно добавить через ALTER TABLE). */
  missingColumns: [string, YdbPrimitive][];
  /** Колонки с несовпадающим типом (YDB не умеет менять тип — только ручная миграция). */
  typeMismatches: { column: string; expected: YdbPrimitive; actual: string }[];
  /** Лишние колонки в БД (не удаляются автоматически — потеря данных). */
  extraColumns: string[];
  /**
   * Вероятные переименования колонок (#23): ровно одна лишняя колонка БД
   * и ровно одна новая колонка сущности с совпадающим типом, не затронутые
   * PK/индексами/TTL/blind-index. Диагностическая подсказка — не команда
   * к действию; ADD/DROP и ручная миграция остаются явными.
   */
  likelyRenames: LikelyRename[];
  primaryKeyMatches: boolean;
  /**
   * Ожидаемый PK из метаданных сущности — копия входа, нужна для
   * диагностики перестановок порядка (#89).
   */
  expectedPrimaryKey: string[];
  /** Фактический PK из DescribeTable (для диагностики порядка, #89). */
  actualPrimaryKey: string[];
  /** Ожидаемые PK-колонки, которых нет в PK БД (#89). */
  missingPrimaryKeyColumns: string[];
  /** PK-колонки БД, не объявленные как PK в сущности (#89). */
  extraPrimaryKeyColumns: string[];
  /**
   * Чистая перестановка: наборы PK-колонок совпадают, но порядок
   * различается (#89). В YDB порядок колонок PK определяет
   * партиционирование и сортировку диапазонов, поэтому [tenant, id] и
   * [id, tenant] — принципиально разные таблицы.
   */
  primaryKeyOrderMismatch: boolean;
  /** Индексы, которые есть в метаданных, но нет в БД. */
  missingIndexes: ExpectedIndex[];
  /** Индексы, которые есть в БД, но нет в метаданных. */
  extraIndexes: Array<{ name: string; columns: string[]; unique: boolean }>;
  /** Индексы с несовпадающим флагом unique. */
  uniqueMismatches: { name: string; expected: boolean; actual: boolean }[];
  /** Индексы с тем же именем, но другим списком/порядком колонок. */
  indexColumnsMismatches: {
    name: string;
    expected: string[];
    actual: string[];
  }[];
  /** TTL объявлен сущностью, но в БД не задан. */
  missingTtl: { expected: YdbTtlMetadata }[];
  /** TTL задан и в БД, и в метаданных, но колонка/unit/интервал различаются. */
  ttlMismatches: { expected: YdbTtlMetadata; actual: YdbTableTtl }[];
  /** В БД задан TTL, которого нет в метаданных (не сбрасывается автоматически). */
  extraTtl: { actual: YdbTableTtl }[];
}

/** Проблема схемы, найденная при verify. */
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

/** YdbPrimitive → PrimitiveTypeId (для сравнения с DescribeTable). */
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
 * Числовые типы TTL-колонок: YDB допускает TTL по Uint32/Uint64/DyNumber
 * с unit, но эти типы не входят в YdbPrimitive (маппинг значений запросов
 * их не поддерживает). Здесь они нужны только для схемного сравнения,
 * чтобы sync/verify не считали такую колонку расхождением типов (#88).
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
 * Текст issues, однозначно говорящий, что путь/таблица не существует (#91).
 * Только такой SCHEME_ERROR трактуется как «таблицы нет»; остальные
 * (права доступа, битый путь и т.п.) пробрасываются наружу. Реальные
 * сообщения YDB: «path '/db/tbl' does not exist», «Path ... not found».
 */
const NOT_FOUND_ISSUE_RE = /does not exist|not found/i;

/** Enum Unit из TtlSettings → YdbTtlUnit (см. @YdbTtl). */
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
 * Строит ожидаемую схему таблицы по метаданным сущности:
 * колонки + synthetic {field}_bi колонки blind index.
 * Требует явно объявленного первичного ключа через @YdbPrimaryColumn.
 *
 * Бросает ошибку (fail-fast, по той же политике, что и для PK) при
 * невалидных метаданных TTL: неизвестная колонка, несовместимый тип
 * (YDB допускает Date/Datetime/Timestamp либо Uint32/Uint64/DyNumber
 * с unit), unit у даты или его отсутствие у числа. Так schema sync,
 * миграции и CLI не сгенерируют заведомо невалидный DDL; при инициализации
 * модуля те же проблемы раньше собирает validateEntityMetadata.
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
 * Ожидаемая схема join-таблицы many-to-many.
 *
 * Имена и типы колонок берутся ровно из того определения, которое построил
 * resolveRelationJoinTableDefinition (#90/#87): типы выводятся из
 * фактических PK-метаданных обеих сущностей, а невыводимый тип — ошибка
 * конфигурации в самом резолве. Отдельного пути вывода типов здесь нет:
 * сгенерированная схема по построению совпадает с тем, что читает
 * relations-код (см. ResolvedJoinTable в entity-relations.ts).
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
 * Собирает ожидаемые схемы всех таблиц сущностей и их many-to-many join-таблиц.
 *
 * Гарантия «одна таблица — одна ожидаемая схема» (#92):
 *  - повтор класса в списке дедуплицируется;
 *  - класс без собственного @YdbEntity пропускается (не сущность — см.
 *    getYdbEntityMetadata), поэтому подкласс не порождает вторую схему
 *    для таблицы родителя;
 *  - две разные сущности с одним tableName — ошибка: иначе sync патчил бы
 *    одну таблицу двумя разными схемами, а verify выдавал противоречивые
 *    issues. Коллизия обнаруживается здесь — до любого обращения к БД.
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
 * Генерирует TTL-секцию WITH (...) для CREATE TABLE.
 * По синтаксису YQL TTL задаётся только в WITH, а не внутри тела таблицы:
 *   WITH (TTL = Interval("PT2H") ON `col` [AS SECONDS])
 */
export function generateTtlWithClause(ttl: YdbTtlMetadata): string {
  return `WITH (\n  ${ttlExpression(ttl)}\n)`;
}

/** Генерирует DDL создания таблицы. */
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

/** Генерирует DDL добавления недостающих колонок (один ALTER на таблицу). */
export function generateAddColumnsYql(
  tableName: string,
  columns: [string, YdbPrimitive][],
): string {
  const clauses = columns.map(
    ([name, type]) => `ADD COLUMN ${quoteIdentifier(name)} ${type}`,
  );
  return `ALTER TABLE ${quoteIdentifier(tableName)} ${clauses.join(', ')}`;
}

/** Генерирует DDL добавления индекса через ALTER TABLE. */
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

/** Генерирует DDL удаления индекса через ALTER TABLE. */
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
 * Генерирует DDL установки/замены TTL через ALTER TABLE.
 * Выражение TTL совпадает с WITH-секцией CREATE TABLE (#81):
 *   ALTER TABLE `t` SET (TTL = Interval("PT2H") ON `col` [AS SECONDS])
 */
export function generateSetTtlYql(
  tableName: string,
  ttl: YdbTtlMetadata,
): string {
  return `ALTER TABLE ${quoteIdentifier(tableName)} SET (${ttlExpression(ttl)})`;
}

/** Генерирует DDL сброса TTL: ALTER TABLE `t` RESET (TTL). */
export function generateResetTtlYql(tableName: string): string {
  return `ALTER TABLE ${quoteIdentifier(tableName)} RESET (TTL)`;
}

/** TTL-выражение `TTL = Interval(...) ON col [AS unit]`, общее для CREATE/ALTER. */
function ttlExpression(ttl: YdbTtlMetadata): string {
  const unitPart = ttl.unit ? ` AS ${ttl.unit.toUpperCase()}` : '';
  return `TTL = Interval("${ttl.interval}") ON ${quoteIdentifier(ttl.column)}${unitPart}`;
}

/** Человекочитаемое представление ожидаемого TTL (для issues/warnings). */
function formatTtlMeta(ttl: YdbTtlMetadata): string {
  const unitPart = ttl.unit ? ` AS ${ttl.unit.toUpperCase()}` : '';
  return `${ttl.interval} on column "${ttl.column}"${unitPart}`;
}

/** Человекочитаемое представление фактического TTL из БД. */
function formatTableTtl(ttl: YdbTableTtl): string {
  const unitPart = ttl.unit ? ` AS ${ttl.unit.toUpperCase()}` : '';
  return (
    `${microsecondsToIsoDuration(ttl.expireAfterSeconds * MICROSECONDS_PER_SECOND)} ` +
    `on column "${ttl.column}"${unitPart}`
  );
}

/**
 * Сравнивает ожидаемый TTL с фактическим из DescribeTable:
 * колонка, unit и интервал. Интервал сравнивается семантически в целых
 * микросекундах (внутренней точности YDB Interval): "PT1H" и "PT60M"
 * равны, "PT0.5S" — это ровно 500000µs, без потерь на float.
 * Интервалы, непредставимые в YDB Interval точно, — календарные части
 * и дробь точнее микросекунд — считаются расхождением, чтобы миграция
 * или синхронизация выставили значение из метаданных вместо ложного
 * «совпадения» после усечения.
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
 * Детекция вероятного переименования колонки (#23).
 *
 * Консервативная эвристика на структурных признаках схемы, без сравнения
 * похожести имён. Подсказка выдаётся, только когда выполнено ВСЁ:
 *  - в БД ровно одна лишняя колонка (`from`) и в сущности ровно одна новая
 *    (`to`) — однозначное соответствие без кандидатов на выбор;
 *  - примитивный тип `to` совпадает с фактическим типом `from` в БД
 *    (колонки неявно неподдерживаемых типов #91 сразу отсекаются);
 *  - ни `from`, ни `to` не участвуют в PK;
 *  - ни `from`, ни `to` не упоминаются в колонках индексов (фактических
 *    и ожидаемых) — иначе это изменение индекса, а не переименование;
 *  - ни `from`, ни `to` не являются TTL-колонкой (фактической или ожидаемой);
 *  - расхождение не затрагивает blind index: обе колонки не synthetic `_bi`
 *    (BLIND_INDEX_SUFFIX) и у каждой нет `_bi`-парта в своей схеме.
 *
 * При любом несоответствии возвращается пустой список — остаются прежние
 * ADD/DROP и предупреждения о ручной миграции.
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

  // Совпадение типа: необходимое условие «это та же колонка».
  const actualTypeId = existing.columns.get(from);
  if (
    actualTypeId === undefined ||
    PRIMITIVE_TO_TYPE_ID[toType] !== actualTypeId
  ) {
    return [];
  }

  // PK: переименование ключевой колонки в YDB невозможно — только ручная миграция.
  if (existing.primaryKey.includes(from) || expected.primaryKey.includes(to)) {
    return [];
  }

  // Индексы: расхождение индексов вокруг пары — это изменение индекса,
  // а не простое переименование.
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

  // TTL: перенос TTL-колонки — изменение настроек TTL, не простое переименование.
  if (existing.ttl?.column === from || expected.ttl?.column === to) return [];

  // Blind index/шифрование: synthetic-колонка либо появление/исчезновение
  // `_bi`-парта — изменение метаданных шифрования.
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
 * Чистая проверка: сравнивает ожидаемую схему с описанием таблицы из БД.
 * Не ходит в сеть и ничего не меняет.
 */
export function checkTableSchema(
  expected: ExpectedTableSchema,
  existing: YdbTableDescription,
): SchemaCheckResult {
  const missingColumns: [string, YdbPrimitive][] = [];
  const typeMismatches: SchemaCheckResult['typeMismatches'] = [];
  const unsupportedColumns = existing.unsupportedColumns;

  for (const [name, type] of Object.entries(expected.columns)) {
    // Не-примитивный тип в БД (#91): по typeId сравнивать нельзя —
    // сообщаем расхождение с фактическим типом (decimal(22,9), list<...>),
    // а не с бессмысленным typeId=0.
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
    // Числовые TTL-типы (Uint32/Uint64/DyNumber) не входят в YdbPrimitive,
    // но валидны для схемного сравнения — см. TTL_NUMERIC_TYPE_IDS.
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
  // Колонка БД живёт либо в columns, либо в unsupportedColumns — но
  // описания могут прийти и из внешнего кода, поэтому дедуплицируем.
  const extraColumns = [
    ...existing.columns.keys(),
    ...(unsupportedColumns?.keys() ?? []),
  ].filter((name) => !expectedColumns.has(name));
  const uniqueExtraColumns = [...new Set(extraColumns)];

  // Порядок колонок PK значим (#89): в YDB он определяет партиционирование
  // и сортировку диапазонов, поэтому [tenant, id] и [id, tenant] — разные
  // таблицы. Сравниваем поэлементно и никогда — как множество.
  const primaryKeyMatches =
    expected.primaryKey.length === existing.primaryKey.length &&
    expected.primaryKey.every((pk, i) => existing.primaryKey[i] === pk);
  const missingPrimaryKeyColumns = expected.primaryKey.filter(
    (pk) => !existing.primaryKey.includes(pk),
  );
  const extraPrimaryKeyColumns = existing.primaryKey.filter(
    (pk) => !expected.primaryKey.includes(pk),
  );
  // Чистая перестановка: наборы равны, порядок различается. Если есть
  // отсутствующие или лишние PK-колонки, случай уже покрыт их списками.
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
    // Колонки сравниваются с учётом порядка: в YDB порядок колонок
    // индекса значим (префиксный поиск), а поменять его нельзя —
    // только пересоздать индекс.
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

  // TTL (#88): отсутствующий, изменённый и лишний — в БД TTL либо задан
  // согласно @YdbTtl, либо его нет вовсе.
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
 * Человекочитаемое описание расхождения первичного ключа (#89):
 * различает чистую перестановку PK-колонок (порядок значим в YDB) и
 * отсутствующие/лишние PK-колонки. Используется в issues verify/diffSchemas
 * и в предупреждениях плана миграций.
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
 * Превращает результат проверки таблицы в плоский список issues.
 * Используется и `YdbSchemaSyncer.verify`, и CLI (красивый diff).
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
  // #23: подсказка о вероятном переименовании — информационная, схему
  // самой по себе не исправляет (колонка по-прежнему отсутствует в БД),
  // поэтому расхождение остаётся и в verify, и в diffSchemas.
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
 * Чистый diff ожидаемых схем против текущего состояния БД
 * (null — таблицы нет). Не ходит в сеть. Используется CLI для
 * человекочитаемого вывода расхождений.
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
 * Синхронизатор схемы БД: создаёт недостающие таблицы и колонки
 * по метаданным сущностей. Изменение типа колонки и первичного ключа
 * в YDB невозможно — такие расхождения приводят к ошибке.
 */
export class YdbSchemaSyncer {
  private readonly logger = new Logger(YdbSchemaSyncer.name);

  constructor(
    private readonly driver: Driver,
    private readonly executor: YdbExecutor,
  ) {}

  /**
   * Проверяет схему БД против метаданных сущностей, ничего не меняя.
   * Возвращает список найденных расхождений.
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
   * Подстраивает БД под схему сущностей:
   *  - нет таблицы — CREATE TABLE;
   *  - нет колонок — ALTER TABLE ADD COLUMN;
   *  - нет индексов — ALTER TABLE ADD INDEX;
   *  - нет TTL или TTL отличается от метаданных — ALTER TABLE SET (TTL = ...)
   *    (SET перезаписывает существующие настройки);
   *  - лишние колонки/индексы/TTL — только предупреждение в лог
   *    (не удаляем данные и настройки);
   *  - расхождение типа/PK/колонок индекса — ошибка (в YDB не меняется,
   *    нужна миграция).
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

      // #23: переименование никогда не применяется автоматически — sync
      // по-прежнему добавляет новую колонку, старую не трогает.
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

      // TTL: отсутствующий ставим, изменённый заменяем — SET (TTL = ...)
      // перезаписывает существующие настройки. Лишний TTL не сбрасываем
      // автоматически: та же политика, что и в planMigration (#88).
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
   * DescribeTable через Table service (query service не отдаёт метаданные
   * колонок). Сессия создаётся на один вызов и сразу закрывается.
   *
   * Возвращает null только если таблицы действительно нет (#91): отдельный
   * статус NOT_FOUND либо SCHEME_ERROR, в issues которого явно сказано, что
   * путь/таблица не существует. Любой другой SCHEME_ERROR (нет прав,
   * битый путь и т.п.) пробрасывается наружу с контекстом — раньше он
   * тоже превращался в null, из-за чего sync делал CREATE TABLE уже
   * существующей таблицы, а verify докладывал ложный missing-table.
   * Публичный: используется также генератором миграций (migration:generate).
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

      // Колонки с не-примитивными типами (Decimal/List/Pg и т.п.) нельзя
      // выразить typeId — они уходят в unsupportedColumns с честным
      // описанием типа, а не с бессмысленным typeId=0 (#91).
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
   * Снимает Optional-обёртки и возвращает примитивный typeId.
   * null — тип не-примитивный (Decimal/List/Pg/…): сравнивать его по typeId
   * нельзя, фактическое описание кладётся в unsupportedColumns (#91),
   * а не подставляется бессмысленный PRIMITIVE_TYPE_ID_UNSPECIFIED (=0).
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
   * Компактное человекочитаемое описание типа из DescribeTable (#91):
   * decimal(22,9), list<utf8>, pg<int4> и т.п. Используется в сообщениях
   * о расхождении типов вместо бессмысленного «typeId=0».
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
        // variantType/taggedType/voidType/… — имя proto-case уже содержит
        // фактическую информацию о типе.
        return t?.case ?? 'unknown';
    }
  }

  /**
   * Нормализует TtlSettings из DescribeTable в YdbTableTtl.
   * Date-режим (dateTypeColumn) не имеет unit; числовой (valueSinceUnixEpoch)
   * маппит enum Unit в YdbTtlUnit, UNSPECIFIED трактуется как отсутствие unit.
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
