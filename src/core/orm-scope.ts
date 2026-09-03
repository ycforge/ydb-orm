import type { YdbTransactionsSettings } from './interfaces.js';

/**
 * Scope of one independent ORM configuration (#199).
 *
 * Previously the configuration was process-global: one executor, one
 * transaction setting, one entity set per process. A scope makes the
 * configuration instance-scoped: each scope has its own transaction settings
 * and its own entity set, while executors/providers are isolated naturally —
 * via per-class entity runtime (an entity physically cannot be attached to two
 * configurations at once).
 *
 * Ownership contract: an entity class belongs to exactly one ACTIVE scope.
 * Re-registration in another scope is a deterministic error (see
 * claimEntitiesForScope). Release happens via releaseOrmScope() (NestJS calls
 * it on application shutdown).
 */
export interface YdbOrmScope {
  /** Configuration name: 'default' or a custom one (NestJS `name`). */
  readonly name: string;
  /**
   * Transaction settings of this configuration (#98/#199). undefined —
   * inherit the process-global settings (configureTransactionContext), which
   * preserves the previous standalone/test behavior.
   */
  transactions?: Required<YdbTransactionsSettings>;
  /** Entities bound to this configuration. */
  readonly entities: Set<YdbEntityClass>;
}

type YdbEntityClass = new (...args: any[]) => any;

/** Default configuration name (backward compatibility). */
export const DEFAULT_ORM_SCOPE_NAME = 'default';

/**
 * Entity ownership: class → active owner scope.
 * A plain Map (not WeakMap): ownership is removed explicitly via
 * releaseOrmScope, and GC of entity classes does not happen in practice.
 */
const entityOwners = new Map<YdbEntityClass, YdbOrmScope>();

function normalizeTransactions(
  settings?: YdbTransactionsSettings,
): Required<YdbTransactionsSettings> {
  return {
    ambient: settings?.ambient ?? false,
    warnOutsideTransaction: settings?.warnOutsideTransaction ?? false,
  };
}

/**
 * Creates a scope for a new independent configuration (#199).
 *
 * Standalone example:
 * ```ts
 * const reporting = createOrmScope('reporting', { transactions: { ambient: true } });
 * configureEntities([ReportEntity], { executor: reportingExecutor, scope: reporting });
 * ```
 */
export function createOrmScope(
  name: string = DEFAULT_ORM_SCOPE_NAME,
  options?: { transactions?: YdbTransactionsSettings },
): YdbOrmScope {
  if (!name) {
    throw new Error('createOrmScope(): scope name must be a non-empty string.');
  }
  return {
    name,
    transactions: options?.transactions
      ? normalizeTransactions(options.transactions)
      : undefined,
    entities: new Set(),
  };
}

let defaultScope: YdbOrmScope | undefined;

/**
 * Default configuration scope — a lazy singleton. It is the one used by
 * configureEntities() without options.scope and by the default NestJS
 * configuration, so a single configuration and repeated bootstrap (tests,
 * hot-restart) keep working as before: the scope is never released, and
 * re-claiming its own entities is idempotent.
 */
export function getDefaultOrmScope(): YdbOrmScope {
  if (!defaultScope) {
    defaultScope = createOrmScope(DEFAULT_ORM_SCOPE_NAME);
  }
  return defaultScope;
}

/**
 * Binds entities to a configuration scope (#199).
 *
 * An entity already owned by ANOTHER active scope is a clear configuration
 * error (the same class cannot live in two configurations: its per-class
 * runtime is single). Re-claiming by the same scope is idempotent — this is a
 * re-bootstrap within one configuration.
 */
export function claimEntitiesForScope(
  scope: YdbOrmScope,
  entities: readonly YdbEntityClass[],
): void {
  for (const entity of entities) {
    const owner = entityOwners.get(entity);
    if (owner && owner !== scope) {
      throw new Error(
        `Entity ${entity.name ?? String(entity)} is already registered in ` +
          `another YDB configuration ("${owner.name}"). ` +
          `The same entity class cannot belong to more than one ORM configuration: ` +
          `its executor/providers are stored per class. ` +
          `Declare a separate entity class for configuration "${scope.name}", ` +
          `or shut down the configuration "${owner.name}" first.`,
      );
    }
  }
  for (const entity of entities) {
    entityOwners.set(entity, scope);
    scope.entities.add(entity);
  }
}

/**
 * Releases the scope's ownership of its entities (application shutdown).
 * Idempotent. After release the entities can be bound to another scope.
 */
export function releaseOrmScope(scope: YdbOrmScope): void {
  for (const entity of scope.entities) {
    if (entityOwners.get(entity) === scope) {
      entityOwners.delete(entity);
    }
  }
  scope.entities.clear();
}

/**
 * Releases ownership of specific entities from a scope (rollback on
 * configuration error). Only entities that actually belong to the scope
 * are released: entities previously bound to the same scope are not affected.
 */
export function releaseEntitiesFromScope(
  scope: YdbOrmScope,
  entities: readonly YdbEntityClass[],
): void {
  for (const entity of entities) {
    if (entityOwners.get(entity) === scope) {
      entityOwners.delete(entity);
      scope.entities.delete(entity);
    }
  }
}

/** Current entity owner (for tests and diagnostics). */
export function getEntityOrmScope(
  entity: YdbEntityClass,
): YdbOrmScope | undefined {
  return entityOwners.get(entity);
}

/**
 * Claims entities in a scope and returns the list of entities that were
 * newly bound (did not previously belong to this scope). Used for
 * ownership rollback on configuration error.
 */
export function claimEntitiesForScopeWithTracking(
  scope: YdbOrmScope,
  entities: readonly YdbEntityClass[],
): YdbEntityClass[] {
  for (const entity of entities) {
    const owner = entityOwners.get(entity);
    if (owner && owner !== scope) {
      throw new Error(
        `Entity ${entity.name ?? String(entity)} is already registered in ` +
          `another YDB configuration ("${owner.name}"). ` +
          `The same entity class cannot belong to more than one ORM configuration: ` +
          `its executor/providers are stored per class. ` +
          `Declare a separate entity class for configuration "${scope.name}", ` +
          `or shut down the configuration "${owner.name}" first.`,
      );
    }
  }

  const newlyClaimed: YdbEntityClass[] = [];
  for (const entity of entities) {
    const wasOwned = entityOwners.has(entity);
    if (!wasOwned) {
      newlyClaimed.push(entity);
    }
    entityOwners.set(entity, scope);
    scope.entities.add(entity);
  }

  return newlyClaimed;
}
