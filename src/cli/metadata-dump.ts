/**
 * metadata:dump (#37): read-only экспорт метаданных сущностей
 * в детерминированный JSON.
 *
 * Гарантии:
 *  - НИКАКОГО I/O в БД: ни драйвера, ни executor'а, ни DDL, ни миграций —
 *    функция синхронная и работает только с метаданными классов;
 *  - весь дамп строится до первого байта вывода: невалидные/незарегистрированные
 *    сущности и конфликтующие метаданные роняют команду с понятной ошибкой,
 *    а не дают частичный вывод;
 *  - детерминизм: стабильный порядок сущностей (по имени таблицы), колонок,
 *    индексов, связей, enum-ов и ключей JSON; повторный вызов на тех же
 *    сущностях даёт побайтово одинаковый JSON;
 *  - сериализуются только простые значения: никаких функций, инстансов
 *    классов, циклических ссылок или внутренних объектов фреймворка;
 *  - формат версионируется (format + version) для безопасной эволюции.
 *
 * Реализация использует только канонические точки резолва ORM — обхода
 * декораторов нет: getYdbEntityMetadata, buildExpectedTableSchema
 * (колонки/PK/индексы/TTL + валидация), getYdbRelationsMetadata,
 * resolveRelationJoinColumn (#87), resolveRelationJoinTableDefinition /
 * getManyToManyJoinTables (#90/#139), getYdbEnumMetadata, getEagerRelations.
 * Семантика наследования #92/#107 наследуется от этих функций автоматически.
 */

import type { YdbPrimitive } from '../core/types.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import {
  buildExpectedSchemas,
  buildExpectedTableSchema,
} from '../schema/schema-sync.js';
import {
  getManyToManyJoinTables,
  getYdbJoinTableMetadata,
  getYdbRelationsMetadata,
  resolveRelationJoinColumn,
  resolveRelationJoinTableDefinition,
  type ManyToManyJoinTable,
  type RelationMetadata,
  type RelationType,
} from '../decorators/relation.decorators.js';
import {
  getYdbEnumMetadata,
  type YdbEnumMeta,
} from '../decorators/enum.decorator.js';
import type { YdbTtlUnit } from '../decorators/ttl.decorator.js';
import { getEagerRelations } from '../decorators/eager.decorator.js';
import { requireEntityMeta } from './migration-verify.js';

/** Идентификатор формата дампа (верхнеуровневое поле format). */
export const METADATA_DUMP_FORMAT = 'ydb-orm/metadata-dump';

/** Версия формата дампа: несовместимые изменения схемы JSON увеличивают её. */
export const METADATA_DUMP_VERSION = 1;

export interface DumpedColumn {
  name: string;
  type: YdbPrimitive;
  /** Входит в первичный ключ. */
  primary: boolean;
}

export interface DumpedIndex {
  name: string;
  /** Колонки индекса — порядок значим (префиксный поиск YDB). */
  columns: string[];
  unique: boolean;
}

export interface DumpedTtl {
  column: string;
  /** ISO 8601 duration ("PT2H", "P30D"). */
  interval: string;
  /** Единица числовой TTL-колонки; отсутствует для Date/Datetime/Timestamp. */
  unit?: YdbTtlUnit;
}

export interface DumpedEnum {
  property: string;
  /** Значения enum — порядок сохранён (семантичен для storage Int32). */
  values: string[];
  storage: 'Utf8' | 'Int32';
}

/**
 * Метаданные шифрования без секретов: только декларативная конфигурация
 * полей. Провайдеры, ключи, salt/secret-материал и runtime-состояние
 * сюда не попадают никогда.
 */
export interface DumpedEncryptedField {
  property: string;
  blindIndex: boolean;
  /** Synthetic-колонка blind index (`{property}_bi`); null, если выключен. */
  blindIndexColumn: string | null;
  /** Ленивая дешифровка (@YdbEncrypted({ lazy: true })). */
  lazy: boolean;
  /** Явный AAD-контекст поля; null — используется AAD по умолчанию. */
  aadOverride: string | null;
}

export interface DumpedRelationTarget {
  /** Имя класса целевой сущности. */
  entity: string;
  /** Имя таблицы целевой сущности. */
  table: string;
}

/**
 * Ссылка m2m-связи на join-таблицу из верхнеуровневого списка joinTables:
 * side='owner' — @JoinTable объявлен на этой связи; side='inverse' — на
 * противоположной стороне (owner указывает, на какой именно).
 */
export interface DumpedJoinTableRef {
  table: string;
  side: 'owner' | 'inverse';
  owner?: { entity: string; property: string };
}

export interface DumpedRelation {
  property: string;
  type: RelationType;
  target: DumpedRelationTarget;
  /**
   * FK-колонка: для many-to-one/one-to-one — колонка этой сущности,
   * для one-to-many — колонка целевой сущности. Для many-to-many отсутствует.
   */
  joinColumn?: string;
  /** Свойство обратной связи на целевой сущности; null, если не объявлено. */
  inverseProperty: string | null;
  /** Только для many-to-many; детали — в верхнеуровневом списке joinTables. */
  joinTable: DumpedJoinTableRef | null;
}

export interface DumpedEntity {
  className: string;
  table: string;
  /** PK-колонки в порядке объявления (в YDB порядок PK значим, #89). */
  primaryKey: string[];
  columns: DumpedColumn[];
  indexes: DumpedIndex[];
  ttl: DumpedTtl | null;
  enums: DumpedEnum[];
  encryptedFields: DumpedEncryptedField[];
  /** PK-колонки — участники AAD-строки шифрования. */
  aadFields: string[];
  /** Колонки с автоматической JSON-сериализацией (хранятся как Utf8). */
  jsonColumns: string[];
  /** Связи, автоматически подгружаемые при find/findAll (#107). */
  eagerLoad: string[];
  relations: DumpedRelation[];
}

/** Физическая join-таблица many-to-many (верхнеуровневый список). */
export interface DumpedJoinTable {
  table: string;
  joinColumn: string;
  joinColumnType: YdbPrimitive;
  inverseJoinColumn: string;
  inverseJoinColumnType: YdbPrimitive;
  owner: { entity: string; table: string; property: string };
  inverse: { entity: string; table: string };
}

export interface MetadataDump {
  format: string;
  version: number;
  entities: DumpedEntity[];
  joinTables: DumpedJoinTable[];
}

type EntityCtor = new (...args: any[]) => any;

/**
 * Строит дамп метаданных для переданного списка сущностей.
 *
 * Список задаёт состав дампа (обычно config.entities из ydb-orm.config.ts);
 * порядок вывода от него не зависит — сущности сортируются по имени таблицы.
 * Чистая синхронная функция: БД не трогает, ошибок конфигурации не глотает.
 */
export function buildMetadataDump(entities: EntityCtor[]): MetadataDump {
  // requireEntityMeta падает сразу для класса без собственного @YdbEntity —
  // иначе остальные канонические функции молча пропустили бы такой класс.
  for (const entity of entities) {
    requireEntityMeta(entity);
  }

  // Повтор класса в списке дедуплицируется (как в buildExpectedSchemas).
  const seen = new Set<EntityCtor>();
  const uniqueEntities: EntityCtor[] = [];
  for (const entity of entities) {
    if (!seen.has(entity)) {
      seen.add(entity);
      uniqueEntities.push(entity);
    }
  }

  // Каноническая валидация модели: дедупликация классов, конфликт имён
  // таблиц (#92), обязательный PK, валидность TTL против схемы. Все ошибки —
  // до какого-либо вывода; ожидаемые схемы дальше служат каноническим
  // источником физических колонок (включая synthetic `{field}_bi`),
  // индексов с resolved-именами и TTL.
  const expectedByTable = new Map(
    buildExpectedSchemas(uniqueEntities).map((schema) => [
      schema.tableName,
      schema,
    ]),
  );

  // Join-таблицы many-to-many: канонический резолв с дедупликацией и
  // детекцией расходящихся объявлений (#139) — конфликты роняют дамп.
  const joinTableDefs = getManyToManyJoinTables(uniqueEntities);

  const dumpedEntities = uniqueEntities
    .map((entity) => dumpEntity(entity, expectedByTable, joinTableDefs))
    .sort((a, b) => compareStrings(a.table, b.table));

  return {
    format: METADATA_DUMP_FORMAT,
    version: METADATA_DUMP_VERSION,
    entities: dumpedEntities,
    joinTables: joinTableDefs
      .map(dumpJoinTable)
      .sort((a, b) => compareStrings(a.table, b.table)),
  };
}

function dumpEntity(
  Entity: EntityCtor,
  expectedByTable: Map<string, ReturnType<typeof buildExpectedTableSchema>>,
  joinTableDefs: ManyToManyJoinTable[],
): DumpedEntity {
  const meta = getYdbEntityMetadata(Entity)!;
  // Ожидаемая схема построена канонически выше (buildExpectedSchemas):
  // физические колонки (включая synthetic `{field}_bi`), индексы
  // с resolved-именами и TTL.
  const expected = expectedByTable.get(meta.tableName)!;

  const columns: DumpedColumn[] = Object.entries(expected.columns)
    .map(([name, type]) => ({
      name,
      type,
      primary: expected.primaryKey.includes(name),
    }))
    .sort((a, b) => compareStrings(a.name, b.name));

  const relations = getYdbRelationsMetadata(Entity)
    .map((rel) => dumpRelation(Entity, rel, joinTableDefs))
    .sort((a, b) => compareStrings(a.property, b.property));

  return {
    className: meta.target.name,
    table: meta.tableName,
    primaryKey: [...expected.primaryKey],
    columns,
    indexes: expected.indexes
      .map((idx) => ({
        name: idx.name,
        columns: [...idx.columns],
        unique: idx.unique,
      }))
      .sort((a, b) => compareStrings(a.name, b.name)),
    ttl: expected.ttl ? dumpTtl(expected.ttl) : null,
    enums: getYdbEnumMetadata(Entity)
      .map((e) => dumpEnum(e))
      .sort((a, b) => compareStrings(a.property, b.property)),
    encryptedFields: meta.encryptedFields
      .map((ef) => ({
        property: ef.propertyKey,
        blindIndex: ef.blindIndex === true,
        blindIndexColumn:
          ef.blindIndex === true ? `${ef.propertyKey}_bi` : null,
        lazy: ef.lazy === true,
        aadOverride: ef.aadOverride ?? null,
      }))
      .sort((a, b) => compareStrings(a.property, b.property)),
    aadFields: [...meta.aadFields],
    jsonColumns: [...meta.jsonColumns].sort(compareStrings),
    eagerLoad: [...getEagerRelations(Entity)],
    relations,
  };
}

function dumpTtl(
  ttl: NonNullable<ReturnType<typeof buildExpectedTableSchema>['ttl']>,
): DumpedTtl {
  return ttl.unit !== undefined
    ? { column: ttl.column, interval: ttl.interval, unit: ttl.unit }
    : { column: ttl.column, interval: ttl.interval };
}

function dumpEnum(e: YdbEnumMeta): DumpedEnum {
  return {
    property: e.propertyKey,
    values: [...e.values],
    storage: e.storage,
  };
}

function dumpRelation(
  Entity: EntityCtor,
  relation: RelationMetadata,
  joinTableDefs: ManyToManyJoinTable[],
): DumpedRelation {
  const TargetCtor = relation.target();
  const targetMeta = getYdbEntityMetadata(TargetCtor);
  if (!targetMeta) {
    throw new Error(
      `relation "${relation.propertyKey}" targets ${TargetCtor.name}, ` +
        `which is not decorated with @YdbEntity`,
    );
  }

  const dumped: DumpedRelation = {
    property: relation.propertyKey,
    type: relation.type,
    target: {
      entity: TargetCtor.name,
      table: targetMeta.tableName,
    },
    inverseProperty: findInverseProperty(Entity, relation),
    joinTable: null,
  };

  if (relation.type !== 'many-to-many') {
    // Тот же строгий резолв, что и в рантайме relations (#87):
    // невалидный селектор/отсутствие join-колонки — ошибка, а не угаданная строка.
    dumped.joinColumn = resolveRelationJoinColumn(relation.joinColumn, {
      entityName: Entity.name,
      relationPropertyKey: relation.propertyKey,
    });
  } else {
    dumped.joinTable = resolveJoinTableRef(Entity, relation, joinTableDefs);
  }

  return dumped;
}

function dumpJoinTable(def: ManyToManyJoinTable): DumpedJoinTable {
  return {
    table: def.tableName,
    joinColumn: def.joinColumn,
    joinColumnType: def.joinColumnType,
    inverseJoinColumn: def.inverseJoinColumn,
    inverseJoinColumnType: def.inverseJoinColumnType,
    owner: {
      entity: def.ownerEntity.name,
      table: def.ownerTableName,
      property: def.ownerProperty,
    },
    inverse: {
      entity: def.inverseEntity.name,
      table: def.inverseTableName,
    },
  };
}

function resolveJoinTableRef(
  Entity: EntityCtor,
  relation: RelationMetadata,
  joinTableDefs: ManyToManyJoinTable[],
): DumpedJoinTableRef | null {
  const ownJoin = getYdbJoinTableMetadata(Entity).find(
    (jt) => jt.propertyKey === relation.propertyKey,
  );
  if (ownJoin) {
    // Канонический резолв объявления (#90/#87): ошибки конфигурации
    // (нет PK, составной PK, невыводимый тип) роняют дамп.
    const definition = resolveRelationJoinTableDefinition(Entity, relation);
    return { table: definition!.tableName, side: 'owner' };
  }

  // Обратная сторона: join-таблица ищется среди определений, владельцами
  // которых являются сущности текущего дампа. Без совпадения — null
  // (владелец может не входить в список сущностей этого дампа).
  const TargetCtor = relation.target();
  let candidates = joinTableDefs.filter(
    (def) => def.ownerEntity === TargetCtor && def.inverseEntity === Entity,
  );
  const inverseProperty = findInverseProperty(Entity, relation);
  if (inverseProperty !== null) {
    const byProperty = candidates.filter(
      (def) => def.ownerProperty === inverseProperty,
    );
    if (byProperty.length) candidates = byProperty;
  }

  return candidates.length === 1
    ? {
        table: candidates[0].tableName,
        side: 'inverse',
        owner: {
          entity: candidates[0].ownerEntity.name,
          property: candidates[0].ownerProperty,
        },
      }
    : null;
}

/**
 * Имя обратного свойства связи, если оно объявлено на целевой сущности.
 *
 *  - many-to-many: селектор inverseSide резолвится тем же строгим
 *    способом, что и join-колонки (#87): ровно одно чтение свойства,
 *    всё остальное — ошибка конфигурации;
 *  - one-to-many ↔ many-to-one: обратная связь ищется по той же
 *    join-колонке (значение колонки сравнивается с PK, поэтому связь
 *    пары однозначно определяется колонкой);
 *  - one-to-one: обратная one-to-one на целевой сущности (каждая сторона
 *    хранит собственную FK-колонку, поэтому соответствие — по типу и цели).
 *
 * Необъявленная обратная связь — норма (однонаправленные связи): null,
 * а не ошибка. Невалидные кандидаты пропускаются: их отвергнет проверка
 * самой сущности-владельца с её контекстом.
 */
function findInverseProperty(
  Entity: EntityCtor,
  relation: RelationMetadata,
): string | null {
  if (relation.type === 'many-to-many') {
    return relation.inverseSide
      ? resolveInverseSideProperty(Entity, relation)
      : null;
  }

  const TargetCtor = relation.target();
  let joinColumn: string | undefined;
  try {
    joinColumn = resolveRelationJoinColumn(relation.joinColumn, {
      entityName: Entity.name,
      relationPropertyKey: relation.propertyKey,
    });
  } catch {
    // Невалидное объявление отвергнет dumpRelation с полным контекстом.
    return null;
  }

  const candidates = getYdbRelationsMetadata(TargetCtor).filter((candidate) => {
    if (candidate.target() !== Entity) return false;
    try {
      switch (relation.type) {
        case 'one-to-many':
          return (
            (candidate.type === 'many-to-one' ||
              candidate.type === 'one-to-one') &&
            resolveRelationJoinColumn(candidate.joinColumn, {
              entityName: TargetCtor.name,
              relationPropertyKey: candidate.propertyKey,
            }) === joinColumn
          );
        case 'many-to-one':
          return (
            candidate.type === 'one-to-many' &&
            resolveRelationJoinColumn(candidate.joinColumn, {
              entityName: TargetCtor.name,
              relationPropertyKey: candidate.propertyKey,
            }) === joinColumn
          );
        case 'one-to-one':
          return candidate.type === 'one-to-one';
        default:
          return false;
      }
    } catch {
      return false;
    }
  });

  return candidates.length === 1 ? candidates[0].propertyKey : null;
}

/**
 * Резолвит селектор inverseSide `(target) => target.property`: прокси-рекордер
 * требует ровно одно чтение свойства — та же строгость, что у join-колонок
 * (#87). Цепочки, вызовы и константы дают ошибку с именем сущности и связи.
 */
function resolveInverseSideProperty(
  Entity: EntityCtor,
  relation: RelationMetadata,
): string {
  const where = `relation "${relation.propertyKey}" on ${Entity.name}`;

  class SelectorRejected extends Error {}

  const accessedProps: string[] = [];
  let lastNode: unknown;
  const makeNode = (): unknown =>
    new Proxy(function inverseSideSelectorTarget() {}, {
      get: (_target, prop) => {
        if (typeof prop === 'symbol') throw new SelectorRejected();
        accessedProps.push(prop);
        lastNode = makeNode();
        return lastNode;
      },
      apply: () => {
        throw new SelectorRejected();
      },
      construct: () => {
        throw new SelectorRejected();
      },
    });

  let result: unknown;
  try {
    result = relation.inverseSide!(makeNode());
  } catch (err) {
    if (!(err instanceof SelectorRejected)) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid inverseSide selector for ${where} (${detail}).`);
    }
    throw new Error(`Invalid inverseSide selector for ${where}.`);
  }

  if (accessedProps.length !== 1 || result !== lastNode) {
    throw new Error(
      `Invalid inverseSide selector for ${where}: only direct property ` +
        `access is supported — (target) => target.property.`,
    );
  }

  return accessedProps[0];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
