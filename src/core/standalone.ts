import type { YdbExecutor } from './interfaces.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import type { AadFormat } from '../encryption/aad.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import {
  getEntityRuntime,
  restoreEntityRuntime,
  snapshotEntityRuntime,
  type EntityRuntime,
} from '../entity/entity-runtime.js';
import { getOrCreateRepository } from '../repository/repository-resolver.js';
import {
  validateEntityMetadataIssues,
  validationIssuesToMessages,
} from '../metadata/validate-entity.js';
import {
  claimEntitiesForScopeWithTracking,
  getDefaultOrmScope,
  releaseEntitiesFromScope,
  type YdbOrmScope,
} from './orm-scope.js';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

/**
 * Entity configuration for programmatic use without NestJS.
 * Validates each entity's metadata, sets the executor,
 * UUID generator (uuidVersion), encryption and validation providers
 * on each provided entity, and creates a YdbRepository for it.
 *
 * Repeated calls fully replace the configuration: if providers
 * are not passed, previous ones are reset (relevant for tests and hot-restart).
 *
 * @example
 * ```ts
 * import { configureEntities, createDriver, createExecutor } from '@ycforge/ydb-orm';
 *
 * const driver = await createDriver({ endpoint: '...', auth: createAuth({ type: 'metadata' }) });
 * const executor = createExecutor(driver, { endpoint: '...', auth: createAuth({ type: 'metadata' }) });
 * configureEntities([UserEntity, PostEntity], { executor });
 * ```
 */
export function configureEntities(
  entities: (new (...args: any[]) => any)[],
  options: {
    executor: YdbExecutor;
    encryptionProvider?: YdbEncryptionProvider;
    blindIndexProvider?: YdbBlindIndexProvider;
    validationProvider?: YdbValidationProvider;
    /** Version of generated UUIDs for PK: v7 (default) or v4. */
    uuidVersion?: 'v4' | 'v7';
    /**
     * Security AAD serialization format (#165): 'v2' (default) or
     * 'legacy' — only for the transition period (decryption of old ciphertext).
     */
    aadFormat?: AadFormat;
    /**
     * Automatic AAD format detection on read (#165): true (by
     * default) — on primary format failure the second is tried, legacy rows
     * remain readable after upgrade to v2; false — strict mode after
     * re-encryption.
     */
    aadReadFallback?: boolean;
    /**
     * Scope of an independent ORM configuration (#199), created via
     * createOrmScope(). Defaults to the process-wide 'default' scope
     * (legacy single-configuration behavior). An entity class can belong
     * to only one active scope: registration in a foreign scope is an error.
     */
    scope?: YdbOrmScope;
  },
): void {
  if (!options?.executor) {
    throw new Error(
      'configureEntities() requires "options.executor". ' +
        'Create it via createExecutor(driver, opts).',
    );
  }

  const scope = options.scope ?? getDefaultOrmScope();

  // 1. Validate all entities BEFORE binding to scope: an invalid
  // entity does not receive executor/providers and leaves no ownership.
  for (const entity of entities) {
    assertEntityClass(entity);
    const issues = validateEntityMetadataIssues(
      entity as unknown as typeof YdbBaseEntity,
      {
        encryptionProviderConfigured: Boolean(options.encryptionProvider),
        blindIndexProviderConfigured: Boolean(options.blindIndexProvider),
      },
    );
    if (issues.length) {
      throw new Error(
        `configureEntities(): metadata validation failed for ${entity.name}:\n` +
          validationIssuesToMessages(issues)
            .map((i) => `  - ${i}`)
            .join('\n'),
      );
    }
  }

  // 2. Bind entities to scope (idempotently) and remember
  // which ones were newly claimed — for rollback on configuration error.
  const newlyClaimed = claimEntitiesForScopeWithTracking(scope, entities);

  // 3. Apply runtime configuration. Take a snapshot of each entity
  // class state before applying, so that on error mid-loop we can
  // roll back all mutations (executor, providers, uuidGenerator,
  // aadFormat, scope, transactions, repository) and leave entities
  // in exactly the same state as before configureEntities.
  const runtimeSnapshots = new Map<typeof YdbBaseEntity, EntityRuntime>();
  for (const entity of entities) {
    const entityClass = entity as unknown as typeof YdbBaseEntity;
    runtimeSnapshots.set(entityClass, snapshotEntityRuntime(entityClass));
  }

  try {
    for (const entity of entities) {
      const entityClass = entity as unknown as typeof YdbBaseEntity;
      const runtime = getEntityRuntime(entityClass);
      runtime.uuidGenerator = options.uuidVersion === 'v4' ? uuidv4 : uuidv7;
      runtime.scope = scope;
      runtime.transactions = scope.transactions;

      entityClass.setExecutor(options.executor);
      entityClass.setEncryptionProvider(options.encryptionProvider);
      entityClass.setBlindIndexProvider(options.blindIndexProvider);
      entityClass.setValidationProvider(options.validationProvider);
      entityClass.setAadFormat(options.aadFormat);
      entityClass.setAadReadFallback(options.aadReadFallback);

      getOrCreateRepository(entityClass);
    }
  } catch (e) {
    for (const entity of entities) {
      const entityClass = entity as unknown as typeof YdbBaseEntity;
      const snapshot = runtimeSnapshots.get(entityClass);
      if (snapshot) {
        restoreEntityRuntime(entityClass, snapshot);
      }
    }
    releaseEntitiesFromScope(scope, newlyClaimed);
    throw e;
  }
}

function assertEntityClass(entity: unknown): void {
  if (
    typeof entity !== 'function' ||
    !(entity.prototype instanceof YdbBaseEntity)
  ) {
    throw new Error(
      `configureEntities(): ${(entity as any)?.name ?? String(entity)} ` +
        `is not a YdbBaseEntity subclass. ` +
        `Only entities extending YdbBaseEntity can be configured.`,
    );
  }
}
