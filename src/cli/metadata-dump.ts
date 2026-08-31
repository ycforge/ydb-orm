/**
 * metadata:dump (#37): read-only export of entity metadata
 * to deterministic JSON.
 *
 * Guarantees:
 *  - NO DB I/O whatsoever: no driver, no executor, no DDL, no migrations —
 *    the function is synchronous and works only with class metadata;
 *  - the entire dump is built before the first byte of output: invalid/unregistered
 *    entities and conflicting metadata fail the command with a clear error,
 *    rather than producing partial output;
 *  - determinism: stable order of entities (by table name), columns,
 *    indexes, relations, enums, and JSON keys; repeated calls on the same
 *    entities yield byte-identical JSON;
 *  - only plain values are serialized: no functions, class instances,
 *    cyclic references, or framework internal objects;
 *  - format is versioned (format + version) for safe evolution.
 *
 * Implementation uses only canonical ORM resolution points — no decorator
 * walk: getYdbEntityMetadata, buildExpectedTableSchema
 * (columns/PK/indexes/TTL + validation), getYdbRelationsMetadata,
 * resolveRelationJoinColumn (#87), resolveRelationJoinTableDefinition /
 * getManyToManyJoinTables (#90/#139), getYdbEnumMetadata, getEagerRelations.
 * Inheritance semantics #92/#107 inherited from these functions automatically.
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
  resolvePropertySelector,
  resolveRelationJoinColumn,
  resolveRelationJoinTableDefinition,
  type ManyToManyJoinTable,
  type RelationMetadata,
  type RelationType,
} from '../decorators/relation.decorators.js';
import { blindIndexColumnName } from '../decorators/encryption.decorator.js';
import {
  getYdbEnumMetadata,
  type YdbEnumMeta,
} from '../decorators/enum.decorator.js';
import type { YdbTtlUnit } from '../decorators/ttl.decorator.js';
import { getEagerRelations } from '../decorators/eager.decorator.js';
import { requireEntityMeta } from './migration-verify.js';
import { compareStrings } from './sort.js';

/** Dump format identifier (top-level `format` field). */
export const METADATA_DUMP_FORMAT = 'ydb-orm/metadata-dump';

/** Dump format version: incremented on incompatible JSON schema changes. */
export const METADATA_DUMP_VERSION = 1;

export interface DumpedColumn {
  name: string;
  type: YdbPrimitive;
  /** Part of the primary key. */
  primary: boolean;
}

export interface DumpedIndex {
  name: string;
  /** Index columns — order is significant (YDB prefix search). */
  columns: string[];
  unique: boolean;
}

export interface DumpedTtl {
  column: string;
  /** ISO 8601 duration ("PT2H", "P30D"). */
  interval: string;
  /** Numeric TTL column unit; absent for Date/Datetime/Timestamp. */
  unit?: YdbTtlUnit;
}

export interface DumpedEnum {
  property: string;
  /** Enum values — order preserved (semantically significant for Int32 storage). */
  values: string[];
  storage: 'Utf8' | 'Int32';
}

/**
 * Encryption metadata without secrets: only declarative field
 * configuration. Providers, keys, salt/secret material and runtime state
 * are never included.
 */
export interface DumpedEncryptedField {
  property: string;
  blindIndex: boolean;
  /** Synthetic blind index column (`{property}_bi`); null when disabled. */
  blindIndexColumn: string | null;
  /** Lazy decryption (@YdbEncrypted({ lazy: true })). */
  lazy: boolean;
  /** Explicit AAD context for the field; null — uses the default AAD. */
  aadOverride: string | null;
}

export interface DumpedRelationTarget {
  /** Class name of the target entity. */
  entity: string;
  /** Table name of the target entity. */
  table: string;
}

/**
 * M2M relation reference to a join table from the top-level joinTables
 * list: side='owner' — @JoinTable declared on this relation;
 * side='inverse' — declared on the opposite side (owner indicates which).
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
   * FK column: for many-to-one/one-to-one — this entity's column;
   * for one-to-many — the target entity's column. Absent for many-to-many.
   */
  joinColumn?: string;
  /** Inverse relation property on the target entity; null if not declared. */
  inverseProperty: string | null;
  /** Only for many-to-many; details in the top-level joinTables list. */
  joinTable: DumpedJoinTableRef | null;
}

export interface DumpedEntity {
  className: string;
  table: string;
  /** PK columns in declaration order (YDB PK order is significant, #89). */
  primaryKey: string[];
  columns: DumpedColumn[];
  indexes: DumpedIndex[];
  ttl: DumpedTtl | null;
  enums: DumpedEnum[];
  encryptedFields: DumpedEncryptedField[];
  /** PK columns that participate in the encryption AAD string. */
  aadFields: string[];
  /** Columns with automatic JSON serialization (stored as Utf8). */
  jsonColumns: string[];
  /** Relations auto-loaded during find/findAll (#107). */
  eagerLoad: string[];
  relations: DumpedRelation[];
}

/** Physical many-to-many join table (top-level list). */
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
 * Builds a metadata dump for the given list of entities.
 *
 * The list defines the dump composition (usually config.entities from
 * ydb-orm.config.ts); output order does not depend on it — entities are
 * sorted by table name. Pure synchronous function: does not touch the DB
 * and does not swallow configuration errors.
 */
export function buildMetadataDump(entities: EntityCtor[]): MetadataDump {
  // requireEntityMeta fails immediately for a class without its own @YdbEntity —
  // otherwise other canonical functions would silently pass such a class.
  for (const entity of entities) {
    requireEntityMeta(entity);
  }

  // Duplicate class in list is deduplicated (like in buildExpectedSchemas).
  const seen = new Set<EntityCtor>();
  const uniqueEntities: EntityCtor[] = [];
  for (const entity of entities) {
    if (!seen.has(entity)) {
      seen.add(entity);
      uniqueEntities.push(entity);
    }
  }

  // Canonical model validation: class deduplication, table name conflicts
  // (#92), required PK, TTL validity against schema. All errors —
  // before any output; expected schemas further serve as the canonical
  // source of physical columns (including synthetic `{field}_bi`),
  // indexes with resolved names, and TTL.
  const expectedByTable = new Map(
    buildExpectedSchemas(uniqueEntities).map((schema) => [
      schema.tableName,
      schema,
    ]),
  );

  // Many-to-many join tables: canonical resolution with deduplication and
  // detection of conflicting declarations (#139) — conflicts fail the dump.
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
  // Expected schema built canonically above (buildExpectedSchemas):
  // physical columns (including synthetic `{field}_bi`), indexes
  // with resolved names, and TTL.
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
          ef.blindIndex === true ? blindIndexColumnName(ef.propertyKey) : null,
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
    // Same strict resolution as in runtime relations (#87):
    // invalid selector/missing join column — error, not a guessed string.
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
    // Canonical declaration resolution (#90/#87): configuration errors
    // (no PK, composite PK, non-inferrable type) fail the dump.
    const definition = resolveRelationJoinTableDefinition(Entity, relation);
    if (!definition) {
      // Invariant: @JoinTable on an m2m relation of a decorated entity always
      // resolves to a definition — undefined here is impossible.
      throw new Error(
        `Cannot resolve join table for relation "${relation.propertyKey}" ` +
          `on ${Entity.name} despite a @JoinTable declaration.`,
      );
    }
    return { table: definition.tableName, side: 'owner' };
  }

  // Inverse side: join table is searched among definitions whose owners
  // are entities in the current dump. No match -> null
  // (owner may not be in this dump's entity list).
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
 * Inverse relation property name, if declared on the target entity.
 *
 *  - many-to-many: inverseSide selector resolved with the same strict
 *    method as join columns (#87): exactly one property read,
 *    everything else — configuration error;
 *  - one-to-many <-> many-to-one: inverse relation found by the same
 *    join column (column value compared with PK, so the pair relation
 *    is uniquely determined by the column);
 *  - one-to-one: inverse one-to-one on target entity (each side stores
 *    its own FK column, so matching is by type and target).
 *
 * Undeclared inverse relation is normal (unidirectional relations): null,
 * not an error. Invalid candidates are skipped: they will be rejected by
 * the owning entity's own validation with its context.
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
    // Invalid declaration will be rejected by dumpRelation with full context.
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
 * Resolves the inverseSide selector `(target) => target.property` using the
 * canonical property selector resolver (#87) — same strictness as join columns:
 * exactly one property read, chains/calls/constants — error with entity
 * and relation name.
 */
function resolveInverseSideProperty(
  Entity: EntityCtor,
  relation: RelationMetadata,
): string {
  const where = `relation "${relation.propertyKey}" on ${Entity.name}`;
  return resolvePropertySelector(
    relation.inverseSide!,
    'inverseSide selector',
    where,
  );
}
