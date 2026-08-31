import type { YdbExecutor } from '../core/interfaces.js';
import type { YdbTransactionsSettings } from '../core/interfaces.js';
import type { YdbOrmScope } from '../core/orm-scope.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { AadFormat } from '../encryption/aad.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import type { YdbBaseEntity } from './base-entity.js';
import type { YdbRepository } from '../repository/ydb-repository.js';

/**
 * Snapshot of dependencies used when creating the repository.
 * Stored in runtime for repository recreation when deps change.
 */
export interface RepositoryDepsSnapshot {
  executor?: YdbExecutor;
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  validationProvider?: YdbValidationProvider;
  uuidGenerator?: () => string;
  aadFormat?: AadFormat;
  aadReadFallback?: boolean;
}

export interface EntityRuntime {
  executor?: YdbExecutor;
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  validationProvider?: YdbValidationProvider;
  /** UUID generator for primary key (default: v7 — see base-entity). */
  uuidGenerator?: () => string;
  /** Security AAD format (#165); undefined = 'v2' by default. */
  aadFormat?: AadFormat;
  /**
   * Automatic AAD format detection on read (#165);
   * undefined = true (safe legacy → v2 transition).
   */
  aadReadFallback?: boolean;
  /** Cached entity repository (lazily created from deps). */
  repository?: YdbRepository<YdbBaseEntity>;
  /** Snapshot of deps used to create the repository. */
  repositoryDeps?: RepositoryDepsSnapshot;
  /**
   * ORM configuration scope that owns this entity (#199);
   * undefined — entity has not been configured yet.
   */
  scope?: YdbOrmScope;
  /**
   * Transaction settings of the owning configuration (#199); undefined —
   * process-global settings are used (legacy behavior).
   */
  transactions?: Required<YdbTransactionsSettings>;
}

/**
 * Runtime dependencies of Active Record entities.
 * Stored separately from classes (not in static fields with any-casts),
 * key is the specific entity class, so subclasses don't share state.
 */
const runtimes = new WeakMap<typeof YdbBaseEntity, EntityRuntime>();

/**
 * Returns the runtime dependencies for an entity class, creating an
 * empty record if none exists yet.
 */
export function getEntityRuntime(target: typeof YdbBaseEntity): EntityRuntime {
  let runtime = runtimes.get(target);
  if (!runtime) {
    runtime = {};
    runtimes.set(target, runtime);
  }
  return runtime;
}

/**
 * Snapshot of entity runtime state BEFORE applying configuration for
 * atomic rollback (#200). Used by configureEntities() and
 * createActiveRecordEntityProvider(): if configuration fails after
 * part of runtime has been changed, restoreEntityRuntime() returns the
 * entity to exactly the state it was in before the call.
 *
 * Contract (required for correctness of shallow snapshot):
 * configuration replaces only TOP-LEVEL runtime fields (executor,
 * providers, uuidGenerator, aadFormat, aadReadFallback, scope, transactions,
 * repository, repositoryDeps), assigning new values by reference. No nested
 * value (scope.transactions, repositoryDeps, repository) is mutated in place
 * — so copying references is sufficient for exact restoration of previous
 * references. If a field that mutates in place appears (e.g.,
 * `runtime.transactions.ambient = true`), its snapshot must be made deep
 * here, and restoreEntityRuntime() must be extended.
 */
export function snapshotEntityRuntime(
  entityClass: typeof YdbBaseEntity,
): EntityRuntime {
  return { ...getEntityRuntime(entityClass) };
}

/**
 * Restores entity runtime state from snapshot (see
 * snapshotEntityRuntime). Besides assigning saved references, removes
 * fields that were not in the snapshot: if configuration added a new
 * field (one that didn't exist before the call), it must not survive
 * the rollback.
 */
export function restoreEntityRuntime(
  entityClass: typeof YdbBaseEntity,
  snapshot: EntityRuntime,
): void {
  const runtime = getEntityRuntime(entityClass);
  const snapshotKeys = new Set(Object.keys(snapshot));
  for (const key of Object.keys(runtime)) {
    if (!snapshotKeys.has(key)) {
      delete (runtime as Record<string, unknown>)[key];
    }
  }
  Object.assign(runtime, snapshot);
}
