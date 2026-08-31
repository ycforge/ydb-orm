import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbEntityConstructor } from '../persistence/entity-persistence.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import {
  getYdbRelationsMetadata,
  resolveRelationJoinColumn,
  type RelationMetadata,
} from '../decorators/relation.decorators.js';
import type { QueryOptions } from '../core/query-options.js';
import type { YdbExecutor, YdbQuery } from '../core/interfaces.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import { YdbEntityPersistence } from '../persistence/entity-persistence.js';
import type { HydrationContext } from '../persistence/entity-persistence.js';
import { getEagerRelations } from '../decorators/eager.decorator.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import {
  resolveOperationExecutor,
  createTransactionContext,
  runWithTransactionContext,
  getTransactionId,
  setExecutorIdentity,
} from '../transaction/transaction-context.js';
import { chunkInValues, dedupeInValues } from '../core/query-limits.js';
import { getEntityRuntime } from '../entity/entity-runtime.js';
import { executeYdbQuery } from '../core/execute-query.js';
import { resolveExecutorLogger } from '../core/query-logger.js';
import { mapToYdb } from '../core/mapper.js';
import {
  resolveManyToManyJoinTable,
  type ResolvedJoinTable,
} from './resolve-join-table.js';
import { valueIdentityKey } from '../core/value-identity.js';

/** Canonical value key for relations (#174): Bytes and Date are compared by
 * value, not by reference (hydration creates independent Uint8Array/Date
 * instances, so by-reference valid relations would go "not found"). */
function relationKey(value: unknown): string {
  return valueIdentityKey([value]);
}

/**
 * Relations module dependencies.
 */
export interface RelationsDeps {
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  /**
   * @internal Shared hydration context of one read operation.
   * Passed to the persistence of related entities during batch fetch so that
   * afterFind fires exactly once per instance (see #83).
   */
  hydrationContext?: HydrationContext;
}

/**
 * Relations class: eager loading, lazy loadRelations, many-to-many.
 */
export class YdbEntityRelations<T extends YdbBaseEntity> {
  constructor(
    public readonly entityClass: YdbEntityConstructor<T>,
    private executor: YdbExecutor | undefined,
    private readonly options: RelationsDeps = {},
  ) {}

  /** Updates the executor (called from runtime when deps change). */
  setExecutor(executor: YdbExecutor | undefined): void {
    this.executor = executor;
  }

  private getExecutor(trx?: YdbExecutor): YdbExecutor | undefined {
    // Ambient transaction context (#98): auto-join / no mixing. Settings come
    // from the entity's owning configuration (#199), and so does the logger
    // (#206): warnOutsideTransaction warnings are not emitted by a foreign one.
    return resolveOperationExecutor(
      trx,
      this.executor,
      this.entityClass.name,
      getEntityRuntime(this.entityClass).transactions,
      resolveExecutorLogger(this.executor),
    );
  }

  private createTargetPersistence(
    Target: typeof YdbBaseEntity,
    trx?: YdbExecutor,
  ): YdbEntityPersistence<YdbBaseEntity> {
    return new YdbEntityPersistence(
      Target,
      resolveOperationExecutor(
        trx,
        this.executor,
        this.entityClass.name,
        getEntityRuntime(this.entityClass).transactions,
        resolveExecutorLogger(this.executor),
      ),
      this.options,
    );
  }

  /**
   * Batch loads related entities by an IN (...) column, delegating to the
   * target's persistence (deduplicating, chunking, and hydration rules apply).
   */
  private async fetchByColumnIn(
    Target: typeof YdbBaseEntity,
    column: string,
    values: any[],
    options?: QueryOptions,
    hydration?: { afterFind?: boolean },
  ): Promise<YdbBaseEntity[]> {
    const targetMeta = getYdbEntityMetadata(Target);
    if (!targetMeta) {
      throw new Error(
        `Target entity ${Target.name} is not decorated with @YdbEntity`,
      );
    }
    const targetPersistence = this.createTargetPersistence(
      Target,
      options?.trx,
    );
    return targetPersistence.fetchByColumnIn(
      column,
      values,
      options,
      hydration,
    );
  }

  /**
   * Batch load of many-to-many: join table + inverse entities.
   * Returns a Map<owner PK, related entities[]>.
   *
   * Batching and guards (#86): an empty owner list results in zero queries;
   * duplicate owner PKs are removed; the join select is chunked by
   * MAX_IN_CLAUSE_VALUES (owner-PK chunks do not overlap, so each owner appears
   * in exactly one chunk).
   *
   * Memory is bounded (#209) and semantics equal a single consistent read
   * (#224): the join table is read exactly ONCE per chunk — for each chunk the
   * unique inverse FKs are collected on the fly, the (not-yet-loaded) inverse
   * entities are fetched by them, and the result is filled in. A full `links[]`
   * is never materialized and there is no re-read of the mutable join-table
   * state, so a "pass 1 vs pass 2" desync — a link appearing in the second
   * read but absent from the collected FKs (and thus silently lost) — cannot
   * exist: every inverse FK of the result comes from the same read as its link.
   *
   * Shared instances across chunks: inverse entities are cached by PK in
   * `byInversePk` — one tag shared by several owners in different chunks is
   * hydrated (and gets afterFind) exactly once and is shared between owners by
   * reference. An inverse FK already loaded in another chunk is not fetched
   * again (no N+1, no duplicate instances).
   *
   * Cardinality and ordering match a single read of the join table: identical
   * (owner, inverse) rows are not deduplicated, and an owner's entity order is
   * the order of its chunk rows from the DB.
   */
  private async loadManyToManyRelation(
    items: YdbBaseEntity[],
    Target: typeof YdbBaseEntity,
    joinTable: ResolvedJoinTable,
    ownerPks: any[],
    options?: QueryOptions,
    hydration?: { afterFind?: boolean },
  ): Promise<Map<any, YdbBaseEntity[]>> {
    const exec = this.getExecutor(options?.trx);
    if (!exec) {
      throw new Error(
        `YDB executor not set for entity ${this.entityClass.name}`,
      );
    }

    const uniqueOwnerPks = dedupeInValues(ownerPks);
    if (!uniqueOwnerPks.length) return new Map();

    const ownerPkType = joinTable.ownerColumnType;
    const inverseColumn = joinTable.inverseColumn;
    const ownerColumn = joinTable.ownerColumn;
    const targetPkField = getPrimaryKey(Target);

    const result = new Map<string, YdbBaseEntity[]>();
    // Shared cache of inverse entities: one instance per PK across chunks.
    // It grows up to the number of distinct inverse entities (result scale),
    // not the number of link repetitions.
    const byInversePk = new Map<string, YdbBaseEntity>();

    for (const chunk of chunkInValues(uniqueOwnerPks)) {
      const inParams = chunk.map((_, i) => `$p${i}`).join(', ');

      const sql =
        `SELECT ${quoteIdentifier(ownerColumn)}, ` +
        `${quoteIdentifier(inverseColumn)} ` +
        `FROM ${quoteIdentifier(joinTable.tableName)} ` +
        `WHERE ${quoteIdentifier(ownerColumn)} IN (${inParams})`;

      const joinQuery = exec([sql] as unknown as TemplateStringsArray);
      chunk.forEach((value, i) => {
        joinQuery.parameter(`p${i}`, mapToYdb(ownerPkType, value, ownerColumn));
      });

      const chunkRows = await this.executeQuery(joinQuery, options);
      const rows = (chunkRows[0] ?? []) as { [key: string]: any }[];

      // Unique inverse FKs of this chunk (to fetch the entities).
      const inverseFkValues: any[] = [];
      const seenFk = new Set<string>();
      for (const row of rows) {
        const inverseFk = row[inverseColumn];
        if (inverseFk === undefined || inverseFk === null) continue;
        const key = relationKey(inverseFk);
        if (!seenFk.has(key)) {
          seenFk.add(key);
          inverseFkValues.push(inverseFk);
        }
      }

      // Fetch only the inverse entities not yet in the cache: shared instances
      // across chunks, without re-hydration and without N+1.
      const missing = inverseFkValues.filter(
        (fk) => !byInversePk.has(relationKey(fk)),
      );
      if (missing.length) {
        const relatedEntities = await this.fetchByColumnIn(
          Target,
          targetPkField,
          missing,
          options,
          hydration,
        );
        for (const entity of relatedEntities) {
          byInversePk.set(relationKey((entity as any)[targetPkField]), entity);
        }
      }

      // Fill the result from the rows of this single join-table read: ordering
      // and cardinality match the underlying SELECT.
      for (const row of rows) {
        const ownerFk = row[ownerColumn];
        const inverseFk = row[inverseColumn];
        if (inverseFk === undefined || inverseFk === null) continue;
        const entity = byInversePk.get(relationKey(inverseFk));
        if (!entity) continue;
        const group = result.get(relationKey(ownerFk));
        if (group) {
          group.push(entity);
        } else {
          result.set(relationKey(ownerFk), [entity]);
        }
      }
    }

    return result;
  }

  /**
   * Eager loading: a batch IN (...) per relation level (no N+1).
   *
   * Each @EagerLoad entry is a path of dot-separated relation names
   * (for example `tags.owner`). Allowed path lengths:
   * - one segment — classic single-level eager loading (as before #16);
   * - several segments — nested loading (issue #16): after the first level is
   *   loaded, its instances become the "parents" for the next segment, and the
   *   keys are carried forward by batches.
   */
  async loadEagerRelations(items: T[], options?: QueryOptions): Promise<void> {
    if (!items.length) return;

    const constructor = items[0].constructor as typeof YdbBaseEntity;
    const eager = getEagerRelations(constructor);
    if (!eager.length) return;

    for (const path of eager) {
      await this.loadRelationPath(items, path.split('.'), options);
    }
  }

  /**
   * Single traversal of a relation path (#16): recursively loads path segments,
   * one batch IN (...) per level, carrying the previous level's keys forward.
   *
   * For multi-level paths, the afterFind of intermediate instances is deferred
   * (afterFind: false in hydration) and fires in post-order — after their own
   * children are loaded — via fireAfterFindOn (see #83/#107).
   *
   * An explicit { trx } is threaded through the ENTIRE traversal (#16): for the
   * duration of a multi-level path an internal transaction context is opened
   * (the per-call ambient from #98), so queries WITHOUT an explicit { trx } —
   * including those that fire the afterFind hooks of intermediate levels — go
   * through the same transaction executor. Global ambient is neither needed nor
   * changed; no new transaction/session is created (the SDK runs repeated
   * transaction-executor calls in it), and commit/rollback stays with the
   * transaction owner.
   */
  private async loadRelationPath(
    items: YdbBaseEntity[],
    segments: string[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!items.length || !segments.length) return;

    const constructor = items[0].constructor as typeof YdbBaseEntity;
    const name = segments[0];
    const allRelations = getYdbRelationsMetadata(constructor);
    const rel = allRelations.find((r) => r.propertyKey === name);
    if (!rel) {
      const known = allRelations.map((r) => r.propertyKey).join(', ');
      throw new Error(
        `Unknown relation in eager path "${segments.join('.')}": ` +
          `"${name}" is not a declared relation on entity ${constructor.name}. ` +
          `Known relations: ${known || '(none)'}. Check the property name or ` +
          `declare the relation via @OneToMany/@ManyToOne/@OneToOne/@ManyToMany.`,
      );
    }

    // The internal context is only needed for multi-level paths with an explicit
    // { trx }: single-level eager load and ambient mode behave as before.
    if (options?.trx && segments.length > 1) {
      // Extract the transactionId from the explicit trx (or generate and store
      // one) so resolveOperationExecutor does not complain about mixing transactions.
      const extractedId = getTransactionId(options.trx);
      const transactionId: symbol =
        typeof extractedId === 'symbol' ? extractedId : Symbol('transaction');
      if (typeof extractedId !== 'symbol') {
        if (
          options.trx &&
          (typeof options.trx === 'object' || typeof options.trx === 'function')
        ) {
          setExecutorIdentity(options.trx, transactionId);
        }
      }
      await runWithTransactionContext(
        createTransactionContext({
          transactionId,
          trx: options.trx,
          db: this.executor ?? options.trx,
          ambient: true,
        }),
        () => this.loadRelationSegments(rel, items, segments, options),
      );
      return;
    }

    await this.loadRelationSegments(rel, items, segments, options);
  }

  /** The path traversal body, without transaction-context management (#16). */
  private async loadRelationSegments(
    rel: RelationMetadata,
    items: YdbBaseEntity[],
    segments: string[],
    options?: QueryOptions,
  ): Promise<void> {
    const isIntermediate = segments.length > 1;
    const targets = await this.loadRelation(items, rel, options, {
      afterFind: !isIntermediate,
    });

    if (isIntermediate) {
      // This level's children are already loaded — post-order afterFind fires
      // for this level after its descendants.
      await this.loadRelationPath(targets, segments.slice(1), options);
      await this.fireAfterFindOn(targets, options);
    }
  }

  /**
   * Loads ONE relation for a list of instances with one (or several chunks of)
   * IN (...) and returns the freshly loaded target instances — they become the
   * "parents" of the next level of a nested eager path (#16).
   *
   * `hydration.afterFind:false` is applied for intermediate path levels so that
   * their afterFind fires in post-order (after children).
   * `strict` (for the public loadRelations) preserves the previous error
   * contracts: it throws on undefined PK/FK, whereas the eager path skips them.
   */
  private async loadRelation(
    items: YdbBaseEntity[],
    rel: RelationMetadata,
    options?: QueryOptions,
    hydration: { afterFind?: boolean } = { afterFind: true },
    strict = false,
  ): Promise<YdbBaseEntity[]> {
    const Target = rel.target();
    const constructor = items[0].constructor as typeof YdbBaseEntity;

    if (rel.type === 'one-to-many') {
      const joinColumnName = resolveRelationJoinColumn(rel.joinColumn, {
        entityName: constructor.name,
        relationPropertyKey: rel.propertyKey,
      });
      const pkField = getPrimaryKey(constructor);

      if (strict) {
        for (const item of items) {
          if ((item as any)[pkField] === undefined) {
            throw new Error(
              `Cannot load one-to-many relation "${rel.propertyKey}": ` +
                `primary key "${pkField}" is undefined on ${constructor.name}`,
            );
          }
        }
      }

      // null PKs are left out of the IN (...) — their groups are empty ([]) even
      // without them. In strict mode (public loadRelations) we still assign [],
      // as before #16; in the eager path an empty key list is simply skipped.
      const pks = dedupeInValues(
        items
          .map((item) => (item as any)[pkField])
          .filter((v) => v !== undefined && v !== null),
      );
      if (!pks.length && !strict) return [];

      const children = await this.fetchByColumnIn(
        Target,
        joinColumnName,
        pks,
        options,
        hydration,
      );

      const byFk = new Map<string, YdbBaseEntity[]>();
      for (const child of children) {
        const fk = (child as any)[joinColumnName];
        const group = byFk.get(relationKey(fk));
        if (group) {
          group.push(child);
        } else {
          byFk.set(relationKey(fk), [child]);
        }
      }

      // A copy of the array per instance: two instances sharing one PK must not
      // share a single array (each used to have its own findAll).
      for (const item of items) {
        const group = byFk.get(relationKey((item as any)[pkField]));
        (item as any)[rel.propertyKey] = group ? [...group] : [];
      }
      return children;
    }

    if (rel.type === 'many-to-many') {
      const pkField = getPrimaryKey(constructor);

      const joinTable = resolveManyToManyJoinTable(constructor, rel);
      if (!joinTable) {
        if (strict) {
          throw new Error(
            `Cannot load many-to-many relation "${rel.propertyKey}": ` +
              `join table is not defined on ${constructor.name}. ` +
              `Mark the owning side with @JoinTable.`,
          );
        }
        return [];
      }

      if (strict) {
        for (const item of items) {
          if ((item as any)[pkField] === undefined) {
            throw new Error(
              `Cannot load many-to-many relation "${rel.propertyKey}": ` +
                `primary key "${pkField}" is undefined on ${constructor.name}`,
            );
          }
        }
      }

      const pks = dedupeInValues(
        items
          .map((item) => (item as any)[pkField])
          .filter((v) => v !== undefined && v !== null),
      );
      if (!pks.length && !strict) return [];

      // One batch call for ALL instances instead of a couple of queries each.
      const related = await this.loadManyToManyRelation(
        items,
        Target,
        joinTable,
        pks,
        options,
        hydration,
      );

      for (const item of items) {
        const group = related.get(relationKey((item as any)[pkField]));
        (item as any)[rel.propertyKey] = group ? [...group] : [];
      }

      // Unique target instances (by reference): one tag shared by several
      // owners must appear in the next path levels exactly once.
      const targets: YdbBaseEntity[] = [];
      const seenInst = new Set<object>();
      for (const group of related.values()) {
        for (const entity of group) {
          if (!seenInst.has(entity)) {
            seenInst.add(entity);
            targets.push(entity);
          }
        }
      }
      return targets;
    }

    // many-to-one / one-to-one
    const joinColumnName = resolveRelationJoinColumn(rel.joinColumn, {
      entityName: constructor.name,
      relationPropertyKey: rel.propertyKey,
    });
    const targetPk = getPrimaryKey(Target);

    if (strict) {
      for (const item of items) {
        if ((item as any)[joinColumnName] === undefined) {
          throw new Error(
            `Cannot load relation "${rel.propertyKey}": ` +
              `join column "${joinColumnName}" is undefined on ${constructor.name}`,
          );
        }
      }
    }

    // null FKs are left out of the IN (...) — they are assigned null, as
    // find() with a "PK = NULL" condition would return (empty result).
    const fks = dedupeInValues(
      items
        .map((item) => (item as any)[joinColumnName])
        .filter((v) => v !== undefined && v !== null),
    );
    if (!fks.length && !strict) return [];

    const parents = await this.fetchByColumnIn(
      Target,
      targetPk,
      fks,
      options,
      hydration,
    );

    const byPk = new Map<string, YdbBaseEntity>();
    for (const parent of parents) {
      byPk.set(relationKey((parent as any)[targetPk]), parent);
    }

    for (const item of items) {
      (item as any)[rel.propertyKey] =
        byPk.get(relationKey((item as any)[joinColumnName])) ?? null;
    }
    return parents;
  }

  /**
   * Post-order afterFind for intermediate-level instances of a nested eager
   * path (#16): fires after their children.
   *
   * Persistence is created with the same { trx } as the relation load
   * (#16-fix): the deferred afterFind of an intermediate level does not lose
   * the caller's transaction — any DB operations inside the hooks go through it.
   */
  private async fireAfterFindOn(
    targets: YdbBaseEntity[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!targets.length) return;
    const Target = targets[0].constructor as typeof YdbBaseEntity;
    const targetPersistence = this.createTargetPersistence(
      Target,
      options?.trx,
    );
    await targetPersistence.fireAfterFind(targets);
  }

  /**
   * Explicitly loads relations for one or more instances.
   *
   * Batching (#86): for each relation all FK/PK values across the instance list
   * are collected first, then one (or several chunks of) IN (...) query runs —
   * as in the eager path. Previously each relation type sent a query PER
   * INSTANCE: 100 records = 100-200 queries.
   *
   * Delegates to the shared loadRelation (#16) in strict mode: it checks for an
   * unknown relation name and preserves the previous error contracts for
   * undefined PK/FK and a missing join table.
   */
  async loadRelations(
    items: T[],
    relationNames: string[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!items.length) return;

    const constructor = items[0].constructor as typeof YdbBaseEntity;
    const allRelations = getYdbRelationsMetadata(constructor);

    for (const name of relationNames) {
      const rel = allRelations.find((r) => r.propertyKey === name);
      if (!rel) {
        const known = allRelations.map((r) => r.propertyKey).join(', ');
        throw new Error(
          `Unknown relation: "${name}" on entity ${constructor.name}. ` +
            `Known relations: ${known || '(none)'}. ` +
            `Check the property name or declare the relation ` +
            `via @OneToMany/@ManyToOne/@OneToOne/@ManyToMany.`,
        );
      }

      await this.loadRelation(items, rel, options, { afterFind: true }, true);
    }
  }

  private async executeQuery(
    query: YdbQuery,
    options?: QueryOptions,
  ): Promise<any[][]> {
    return executeYdbQuery<any[][]>(query, options);
  }
}

/** Returns the first PK from the metadata. Throws if no PK is declared. */
function getPrimaryKey(target: typeof YdbBaseEntity): string {
  const meta = getYdbEntityMetadata(target);
  if (!meta?.primaryKeys?.length) {
    throw new Error(`Entity ${target.name} must declare a primary key`);
  }
  return meta.primaryKeys[0];
}
