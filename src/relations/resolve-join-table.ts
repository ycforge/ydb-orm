import type { YdbBaseEntity } from '../entity/base-entity.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import {
  assertNoForeignJoinTableConflicts,
  getManyToManyJoinTables,
} from '../decorators/relation.decorators.js';
import type { YdbPrimitive } from '../core/types.js';

/**
 * Many-to-many join-table metadata, oriented relative to the requesting
 * entity (the owner).
 *
 * Extracted from entity-relations into a separate module (#17): related filters
 * in entity-persistence use the same resolution as eager/lazy loading, and a
 * direct import of entity-relations from persistence would create a cycle.
 */
export interface ResolvedJoinTable {
  tableName: string;
  ownerColumn: string;
  inverseColumn: string;
  /**
   * YDB type of the join table's owner column (#90): the owner entity's PK type.
   * The join-table schema (schema sync) derives the same names and types, so
   * reads are always compatible with the generated table.
   */
  ownerColumnType: YdbPrimitive;
  ownerEntity: typeof YdbBaseEntity;
  inverseEntity: typeof YdbBaseEntity;
}

/**
 * Resolves the join-table metadata for a many-to-many relation.
 *
 * Validation and conflict resolution run through the same code used for schema
 * generation: getManyToManyJoinTables for the entity pair. The runtime
 * therefore cannot silently pick one of diverging table declarations — it
 * throws the same conflict error as schema sync/migrations (#139).
 */
export function resolveManyToManyJoinTable(
  owner: typeof YdbBaseEntity,
  relation: { propertyKey: string; target: () => typeof YdbBaseEntity },
): ResolvedJoinTable | undefined {
  const ownerMeta = getYdbEntityMetadata(owner);
  const inverseEntity = relation.target();
  const inverseMeta = getYdbEntityMetadata(inverseEntity);
  if (!ownerMeta || !inverseMeta) return undefined;

  // All join-table declarations visible for the (owner, inverse) pair: PKs and
  // conflicts of same-name declarations are checked here as well (#90/#139).
  const definitions = getManyToManyJoinTables([owner, inverseEntity]);

  // A declaration on the owner itself for this relation.
  const own = definitions.find(
    (d) => d.ownerEntity === owner && d.ownerProperty === relation.propertyKey,
  );
  if (own) {
    assertNoForeignJoinTableConflicts(own);
    return {
      tableName: own.tableName,
      ownerColumn: own.joinColumn,
      inverseColumn: own.inverseJoinColumn,
      // The name, type and entities come from the same definition used to
      // build the join-table schema (#87): no divergence between the runtime
      // and schema sync is possible.
      ownerColumnType: own.joinColumnType,
      ownerEntity: owner,
      inverseEntity,
    };
  }

  // A mirrored declaration on the inverse side: the columns are flipped — the
  // declaration's joinColumn belongs to the inverse entity, and its
  // inverseJoinColumn to the owner.
  const inverseOwned = definitions.find(
    (d) => d.ownerEntity === inverseEntity && d.inverseEntity === owner,
  );
  if (inverseOwned) {
    assertNoForeignJoinTableConflicts(inverseOwned);
    return {
      tableName: inverseOwned.tableName,
      ownerColumn: inverseOwned.inverseJoinColumn,
      inverseColumn: inverseOwned.joinColumn,
      // Owner-column type = owner PK type = its column type in the declaration.
      ownerColumnType: inverseOwned.inverseJoinColumnType,
      ownerEntity: owner,
      inverseEntity,
    };
  }

  return undefined;
}
