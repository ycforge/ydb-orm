import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { getRegisteredYdbEntities } from '../metadata/entity-registry.js';

/** Metadata key for relations (`@OneToMany`/`@ManyToOne`/`@OneToOne`/`@ManyToMany`). */
export const YDB_RELATIONS_KEY = 'ydb:relations';
/** Metadata key for join tables (`@JoinTable`). */
export const YDB_JOIN_TABLES_KEY = 'ydb:joinTables';

export type RelationType =
  'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';

export interface RelationMetadata {
  propertyKey: string;
  type: RelationType;
  target: () => typeof YdbBaseEntity;
  /** For one-to-many/many-to-one/one-to-one — the FK column. Not used for many-to-many. */
  joinColumn?: string | ((target: any) => any);
  /** For many-to-many — a selector of the inverse property (bidirectional relations). */
  inverseSide?: (target: any) => string;
}

export interface JoinTableMetadata {
  propertyKey: string;
  tableName: string;
  /**
   * Column referring to the owning entity
   * (default `{ownerTable}_{pkProperty}`, #90).
   */
  joinColumn?: string;
  /**
   * Column referring to the inverse entity
   * (default `{inverseTable}_{pkProperty}`, #90).
   */
  inverseJoinColumn?: string;
}

/** Join-table description of a many-to-many relation, computed from entity metadata. */
export interface ManyToManyJoinTable {
  tableName: string;
  joinColumn: string;
  inverseJoinColumn: string;
  /**
   * YDB type of the column referring to the owner (#90/#87): derived from the
   * owner entity's actual PK. Required: resolution always derives the type
   * from the PK or throws a clear configuration error — there is no silent
   * fallback to Uuid (#87).
   */
  joinColumnType: YdbPrimitive;
  /** YDB type of the column referring to the inverse entity (analogous to #87). */
  inverseJoinColumnType: YdbPrimitive;
  ownerEntity: typeof YdbBaseEntity;
  ownerTableName: string;
  ownerProperty: string;
  inverseEntity: typeof YdbBaseEntity;
  inverseTableName: string;
}

/**
 * Default join-column name: `{tableName}_{pkProperty}` (#90).
 * For a PK named `uuid` this is the historical `{tableName}_uuid` — existing
 * relations keep their names; for a non-uuid PK the name is derived from the
 * real PK property instead of silently assuming `_uuid`.
 */
export function defaultJoinColumnName(
  tableName: string,
  pkProperty: string,
): string {
  return `${tableName}_${pkProperty}`;
}

/**
 * Context for join-column configuration error messages (#87).
 */
export interface JoinColumnResolutionContext {
  /** Name of the entity class owning the relation. */
  entityName: string;
  /** The relation property (@OneToMany/@ManyToOne/@OneToOne). */
  relationPropertyKey: string;
}

/**
 * Strict resolution of a relation's join-column declaration (#87).
 *
 * Exactly two forms are supported:
 *  - a non-empty string — the column name;
 *  - a property selector: `(target) => target.property` (dot or bracket
 *    notation with a single property read).
 *
 * Everything else is a configuration error, not a silently guessed string:
 * property chains (`x.a.b`), method calls (`x.getFk()`), constants
 * (`() => 'col'`) and an unused argument are rejected with an error that
 * names the entity and the relation.
 *
 * The single resolution point: used by the relations runtime and
 * validateEntityMetadata — no divergence between the paths (#87).
 *
 * @param joinColumn - The join column declaration (string or selector).
 * @param ctx - Resolution context for error messages.
 * @returns Resolved column name.
 * @throws If joinColumn is invalid or missing.
 */
export function resolveRelationJoinColumn(
  joinColumn: string | ((target: any) => any) | undefined | null,
  ctx: JoinColumnResolutionContext,
): string {
  const where = `relation "${ctx.relationPropertyKey}" on ${ctx.entityName}`;

  if (joinColumn === undefined || joinColumn === null) {
    throw new Error(
      `Join column is required for ${where}: ` +
        `pass a column name or a property selector (target) => target.property.`,
    );
  }

  if (typeof joinColumn === 'string') {
    if (joinColumn.trim().length === 0) {
      throw new Error(
        `Invalid join column declaration for ${where}: ` +
          `column name must be a non-empty string.`,
      );
    }
    return joinColumn;
  }

  if (typeof joinColumn !== 'function') {
    throw new Error(
      `Invalid join column declaration for ${where}: ` +
        `expected a non-empty string or a property selector ` +
        `(target) => target.property, got ${typeof joinColumn}.`,
    );
  }

  return resolvePropertySelector(joinColumn, 'join column selector', where);
}

/**
 * Strict resolution of the `(target) => target.property` selector: a proxy
 * recorder reads exactly one property access. Any other form (chain, call,
 * symbol, computed value) yields a clear error instead of a guessed column
 * string (#87).
 *
 * The single resolution point for property selectors: used by join columns
 * (#87) and the many-to-many inverseSide selector (metadata:dump, #37) —
 * no divergence between the paths. `what` is the selector's label in error
 * text ("join column selector", "inverseSide selector").
 *
 * @param selector - Property selector function.
 * @param what - Selector label for error messages.
 * @param where - Context for error messages.
 * @returns Resolved property name.
 * @throws If selector is not a direct property access.
 */
export function resolvePropertySelector(
  selector: (target: any) => any,
  what: string,
  where: string,
): string {
  const accessedProps: string[] = [];
  let lastNode: unknown;

  /** Marker of the recorder's internal error: distinguished from user errors. */
  class SelectorRejected extends Error {}

  const makeNode = (): unknown =>
    new Proxy(function joinColumnSelectorTarget() {}, {
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
    result = selector(makeNode());
  } catch (err) {
    if (!(err instanceof SelectorRejected)) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`${invalidSelectorMessage(what, where)} (${detail}).`);
    }
    throw new Error(invalidSelectorMessage(what, where));
  }

  if (accessedProps.length !== 1 || result !== lastNode) {
    const detail = accessedProps.length
      ? `unsupported selector form (target.${accessedProps.join('.')})`
      : 'the target argument was not used to select a property';
    throw new Error(`${invalidSelectorMessage(what, where)} — ${detail}.`);
  }

  return accessedProps[0];
}

function invalidSelectorMessage(what: string, where: string): string {
  return (
    `Invalid ${what} for ${where}: ` +
    `only direct property access is supported — (target) => target.property`
  );
}

function defineRelation(prototype: object, metadata: RelationMetadata): void {
  const constructor = (prototype as any).constructor;
  const inherited: RelationMetadata[] =
    Reflect.getMetadata(YDB_RELATIONS_KEY, constructor) || [];
  const relations: RelationMetadata[] = [...inherited, metadata];
  Reflect.defineMetadata(YDB_RELATIONS_KEY, relations, constructor);
}

/**
 * Declares a one-to-many relation: each row in the target table references
 * this entity via the FK column (or a property selector resolving to one).
 *
 * @param target - Lazy identity of the related entity class.
 * @param joinColumn - The FK column name or a `(target) => target.property` selector.
 * @returns Property decorator function.
 */
export function OneToMany(
  target: () => typeof YdbBaseEntity,
  joinColumn: string | ((target: any) => any),
): PropertyDecorator {
  return (prototype, propertyKey) => {
    defineRelation(prototype, {
      propertyKey: propertyKey as string,
      type: 'one-to-many',
      target,
      joinColumn,
    });
  };
}

/**
 * Declares a many-to-one relation: this entity references the target's row
 * via the FK column (or a property selector resolving to one).
 *
 * @param target - Lazy identity of the related entity class.
 * @param joinColumn - The FK column name or a `(target) => target.property` selector.
 * @returns Property decorator function.
 */
export function ManyToOne(
  target: () => typeof YdbBaseEntity,
  joinColumn: string | ((target: any) => any),
): PropertyDecorator {
  return (prototype, propertyKey) => {
    defineRelation(prototype, {
      propertyKey: propertyKey as string,
      type: 'many-to-one',
      target,
      joinColumn,
    });
  };
}

/**
 * Declares a one-to-one relation between this entity and the target via the
 * FK column (or a property selector resolving to one).
 *
 * @param target - Lazy identity of the related entity class.
 * @param joinColumn - The FK column name or a `(target) => target.property` selector.
 * @returns Property decorator function.
 */
export function OneToOne(
  target: () => typeof YdbBaseEntity,
  joinColumn: string | ((target: any) => any),
): PropertyDecorator {
  return (prototype, propertyKey) => {
    defineRelation(prototype, {
      propertyKey: propertyKey as string,
      type: 'one-to-one',
      target,
      joinColumn,
    });
  };
}

/**
 * Declares a many-to-many relation backed by a join table. Combine with
 * @JoinTable on the owning side; the inverse side may provide an
 * `inverseSide` selector for bidirectional navigation.
 *
 * @param target - Lazy identity of the related entity class.
 * @param inverseSide - Optional selector resolving the inverse relation property.
 * @returns Property decorator function.
 */
export function ManyToMany(
  target: () => typeof YdbBaseEntity,
  inverseSide?: (target: any) => string,
): PropertyDecorator {
  return (prototype, propertyKey) => {
    defineRelation(prototype, {
      propertyKey: propertyKey as string,
      type: 'many-to-many',
      target,
      inverseSide,
    });
  };
}

/**
 * Sets the join table for a many-to-many relation. Applied to the owning
 * side of the relation.
 *
 * @param tableName - Join table name.
 * @param options - Optional join column and inverse join column names.
 * @returns Property decorator function.
 * @example
 *   @ManyToMany(() => Tag)
 *   @JoinTable('photo_tag')
 *   tags: Tag[];
 */
export function JoinTable(
  tableName: string,
  options?: Omit<JoinTableMetadata, 'propertyKey' | 'tableName'>,
): PropertyDecorator {
  return (prototype, propertyKey) => {
    const constructor = (prototype as any).constructor;
    const inherited: JoinTableMetadata[] =
      Reflect.getMetadata(YDB_JOIN_TABLES_KEY, constructor) || [];
    const joinTables: JoinTableMetadata[] = [
      ...inherited,
      {
        propertyKey: propertyKey as string,
        tableName,
        ...options,
      },
    ];
    Reflect.defineMetadata(YDB_JOIN_TABLES_KEY, joinTables, constructor);
  };
}

/**
 * Returns the relations metadata declared on an entity class.
 *
 * @param target - Entity class constructor.
 * @returns Array of relation metadata entries.
 */
export function getYdbRelationsMetadata(target: any): RelationMetadata[] {
  return Reflect.getMetadata(YDB_RELATIONS_KEY, target) || [];
}

/**
 * Returns the join-table metadata declared on an entity class.
 *
 * @param target - Entity class constructor.
 * @returns Array of join table metadata entries.
 */
export function getYdbJoinTableMetadata(target: any): JoinTableMetadata[] {
  return Reflect.getMetadata(YDB_JOIN_TABLES_KEY, target) || [];
}

/**
 * Resolves a SINGLE join-table declaration: owner + the specific m2m relation
 * with @JoinTable. Validates the PKs of both sides, derives default column
 * names from the actual PKs and their YDB types (#90).
 *
 * The single resolution point for a declaration: used both by schema
 * generation (getManyToManyJoinTables) and the relations runtime (#139) —
 * the open/validation algorithm is not duplicated anywhere.
 *
 * @param Entity - Owner entity class.
 * @param relation - The many-to-many relation metadata.
 * @returns Resolved join table definition or undefined if not applicable.
 * @throws If PKs are missing, composite, or types cannot be derived.
 */
export function resolveRelationJoinTableDefinition(
  Entity: new (...args: any[]) => any,
  relation: RelationMetadata,
): ManyToManyJoinTable | undefined {
  if (relation.type !== 'many-to-many') return undefined;

  const meta = getYdbEntityMetadata(Entity);
  if (!meta) return undefined;

  const joinTable = getYdbJoinTableMetadata(Entity).find(
    (jt) => jt.propertyKey === relation.propertyKey,
  );
  if (!joinTable) return undefined;

  const InverseEntity = relation.target();
  const inverseMeta = getYdbEntityMetadata(InverseEntity);
  if (!inverseMeta) {
    throw new Error(
      `ManyToMany relation "${relation.propertyKey}" on ${Entity.name} ` +
        `targets ${InverseEntity.name}, which is not decorated with @YdbEntity`,
    );
  }

  // Relation context for configuration errors (#87): the error always names
  // the entities, the relation property and the join table, not just one entity.
  const relationDesc =
    `${Entity.name}.${relation.propertyKey} -> ${InverseEntity.name} ` +
    `(join table "${joinTable.tableName}")`;

  if (meta.primaryKeys.length === 0) {
    throw new Error(
      `Cannot build many-to-many join table for relation "${relationDesc}": ` +
        `owner entity ${Entity.name} declares no primary key. ` +
        `Mark at least one column with @YdbPrimaryColumn.`,
    );
  }
  if (inverseMeta.primaryKeys.length === 0) {
    throw new Error(
      `Cannot build many-to-many join table for relation "${relationDesc}": ` +
        `inverse entity ${InverseEntity.name} declares no primary key. ` +
        `Mark at least one column with @YdbPrimaryColumn.`,
    );
  }

  // The runtime many-to-many model links rows by exactly one PK value on
  // each side; a composite PK would produce a join table that does not match
  // what the relations code reads — we refuse explicitly (#90/#87). The
  // refusal is deterministic: the same resolver is used by schema generation,
  // metadata validation, eager loading, loadRelations and the join-table
  // runtime — there is no path with partial support.
  if (meta.primaryKeys.length > 1) {
    throw new Error(
      `Cannot build many-to-many join table for relation "${relationDesc}": ` +
        `owner entity ${Entity.name} has composite primary keys ` +
        `(${meta.primaryKeys.join(', ')}) that are not supported in ` +
        `many-to-many relations. Declare a single-column @YdbPrimaryColumn.`,
    );
  }
  if (inverseMeta.primaryKeys.length > 1) {
    throw new Error(
      `Cannot build many-to-many join table for relation "${relationDesc}": ` +
        `inverse entity ${InverseEntity.name} has composite primary keys ` +
        `(${inverseMeta.primaryKeys.join(', ')}) that are not supported in ` +
        `many-to-many relations. Declare a single-column @YdbPrimaryColumn.`,
    );
  }

  const ownerPk = meta.primaryKeys[0];
  const inversePk = inverseMeta.primaryKeys[0];

  // Default names are derived from the actual PK columns (#90):
  // for a "uuid" PK this is the previous `{table}_uuid`, for others — `{table}_{pk}`.
  const resolvedJoinColumn =
    joinTable.joinColumn ?? defaultJoinColumnName(meta.tableName, ownerPk);
  const resolvedInverseJoinColumn =
    joinTable.inverseJoinColumn ??
    defaultJoinColumnName(inverseMeta.tableName, inversePk);

  // Join-column type = the entity's exact PK column type (#90/#87).
  // If the type cannot be derived — a configuration error; there is no silent
  // fallback to Uuid: it would produce a schema incompatible with the data.
  const ownerPkType = meta.schema[ownerPk];
  if (!ownerPkType) {
    throw new Error(
      `Cannot derive type of join column "${resolvedJoinColumn}" ` +
        `for relation "${relationDesc}": primary key "${ownerPk}" of ` +
        `${Entity.name} is not declared via @YdbColumn/@YdbPrimaryColumn. ` +
        `Join-table columns reuse the exact primary key type — ` +
        `there is no implicit fallback.`,
    );
  }
  const inversePkType = inverseMeta.schema[inversePk];
  if (!inversePkType) {
    throw new Error(
      `Cannot derive type of inverse join column "${resolvedInverseJoinColumn}" ` +
        `for relation "${relationDesc}": primary key "${inversePk}" of ` +
        `${InverseEntity.name} is not declared via @YdbColumn/@YdbPrimaryColumn. ` +
        `Join-table columns reuse the exact primary key type — ` +
        `there is no implicit fallback.`,
    );
  }

  return {
    tableName: joinTable.tableName,
    joinColumn: resolvedJoinColumn,
    inverseJoinColumn: resolvedInverseJoinColumn,
    joinColumnType: ownerPkType,
    inverseJoinColumnType: inversePkType,
    ownerEntity: Entity as typeof YdbBaseEntity,
    ownerTableName: meta.tableName,
    ownerProperty: relation.propertyKey,
    inverseEntity: InverseEntity,
    inverseTableName: inverseMeta.tableName,
  };
}

/**
 * Returns the many-to-many join tables owned by the given entities.
 * The inverse side (without @JoinTable) does not produce a separate table.
 *
 * One join-table name may be declared multiple times (e.g. mirrored on both
 * sides of the relation, or when the class repeats in the input list).
 * Repeated declarations are safely deduplicated only when they describe an
 * identical physical table (#139); diverging ones are an error listing all
 * definitions: otherwise sync/migrations would silently build a schema from
 * the first declaration while relations code reads by a different one.
 *
 * @param entities - Array of entity classes.
 * @returns Array of resolved join table definitions.
 * @throws If conflicting declarations for the same table name exist.
 */
export function getManyToManyJoinTables(
  entities: (new (...args: any[]) => any)[],
): ManyToManyJoinTable[] {
  const groups = new Map<string, ManyToManyJoinTable[]>();

  for (const Entity of entities) {
    const relations = getYdbRelationsMetadata(Entity);

    for (const relation of relations) {
      const definition = resolveRelationJoinTableDefinition(Entity, relation);
      if (!definition) continue;

      const group = groups.get(definition.tableName);
      if (!group) {
        groups.set(definition.tableName, [definition]);
      } else if (
        !group.some((d) => joinTableDefinitionsEquivalent(d, definition))
      ) {
        group.push(definition);
      }
    }
  }

  // Diverging declarations of one table name are a conflict: a physical
  // table cannot be built in two different ways (#139).
  for (const group of groups.values()) {
    if (group.length > 1) {
      throw new Error(formatJoinTableConflict(group));
    }
  }

  return [...groups.values()].map(([first]) => first);
}

/**
 * Global reconciliation of a join-table declaration against all registered
 * entities (#139): if the same table name is declared by another relation
 * with a different physical description — an error enumerating the
 * definitions.
 *
 * Called by the relations runtime so that a conflict which schema
 * sync/verify/migrations would reject does not pass silently on read:
 * locally for the (owner, inverse) pair the declaration may be the only one,
 * but the table name is already taken by a diverging declaration elsewhere
 * in the model.
 */
export function assertNoForeignJoinTableConflicts(
  canonical: ManyToManyJoinTable,
): void {
  for (const Entity of getRegisteredYdbEntities()) {
    const relations = getYdbRelationsMetadata(Entity);
    for (const relation of relations) {
      // Broken irrelevant declarations must not break reading another
      // relation: a full model scan (schema sync/verify/migrations) will
      // reject them with the same error. Only a real table-name conflict
      // fails this check.
      let other: ManyToManyJoinTable | undefined;
      try {
        other = resolveRelationJoinTableDefinition(Entity, relation);
      } catch {
        continue;
      }
      if (!other || other.tableName !== canonical.tableName) continue;
      // Equivalent (e.g. mirrored) declarations are allowed.
      if (joinTableDefinitionsEquivalent(canonical, other)) continue;
      throw new Error(
        formatJoinTableConflict([canonical, other]) +
          `\nDetected while resolving runtime relation access — the same ` +
          `conflict would fail schema sync/verify/migration generation.`,
      );
    }
  }
}

/**
 * Compares two join-table descriptions as a PHYSICAL table (#139): the
 * "entity → column name + type" pairs match; the declaration direction does
 * not matter (mirrored declarations on both sides are equivalent). Types are
 * derived from the specific entities' PKs, so the comparison also covers PK
 * semantics; entity identity guarantees the same default name/type source.
 *
 * @param a - First join table definition.
 * @param b - Second join table definition.
 * @returns True if definitions describe the same physical table.
 */
export function joinTableDefinitionsEquivalent(
  a: Pick<
    ManyToManyJoinTable,
    | 'ownerEntity'
    | 'joinColumn'
    | 'joinColumnType'
    | 'inverseEntity'
    | 'inverseJoinColumn'
    | 'inverseJoinColumnType'
  >,
  b: Pick<
    ManyToManyJoinTable,
    | 'ownerEntity'
    | 'joinColumn'
    | 'joinColumnType'
    | 'inverseEntity'
    | 'inverseJoinColumn'
    | 'inverseJoinColumnType'
  >,
): boolean {
  const sameSide = (
    e1: typeof YdbBaseEntity,
    c1: string | undefined,
    t1: YdbPrimitive | undefined,
    e2: typeof YdbBaseEntity,
    c2: string | undefined,
    t2: YdbPrimitive | undefined,
  ) => e1 === e2 && c1 === c2 && t1 === t2;

  return (
    (sameSide(
      a.ownerEntity,
      a.joinColumn,
      a.joinColumnType,
      b.ownerEntity,
      b.joinColumn,
      b.joinColumnType,
    ) &&
      sameSide(
        a.inverseEntity,
        a.inverseJoinColumn,
        a.inverseJoinColumnType,
        b.inverseEntity,
        b.inverseJoinColumn,
        b.inverseJoinColumnType,
      )) ||
    (sameSide(
      a.ownerEntity,
      a.joinColumn,
      a.joinColumnType,
      b.inverseEntity,
      b.inverseJoinColumn,
      b.inverseJoinColumnType,
    ) &&
      sameSide(
        a.inverseEntity,
        a.inverseJoinColumn,
        a.inverseJoinColumnType,
        b.ownerEntity,
        b.joinColumn,
        b.joinColumnType,
      ))
  );
}

/** Human-readable description of one join-table definition (for errors). */
function formatJoinTableDefinition(d: ManyToManyJoinTable): string {
  return (
    `- ${d.ownerEntity.name}.${d.ownerProperty} -> ${d.inverseEntity.name} ` +
    `(columns: ${d.joinColumn}:${d.joinColumnType}, ` +
    `${d.inverseJoinColumn}:${d.inverseJoinColumnType})`
  );
}

function formatJoinTableConflict(group: ManyToManyJoinTable[]): string {
  return (
    `Conflicting definitions for many-to-many join table ` +
    `"${group[0].tableName}" (${group.length} declarations):\n` +
    group.map(formatJoinTableDefinition).join('\n') +
    `\nAll @JoinTable declarations sharing a table name must describe the ` +
    `same physical table: identical columns, types and entity pairs.`
  );
}
