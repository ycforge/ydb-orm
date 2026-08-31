import { Provider } from '@nestjs/common';
import {
  YDB_QUERY,
  YDB_OPTIONS,
  YDB_ENCRYPTION_PROVIDER,
  YDB_BLIND_INDEX_PROVIDER,
  YDB_VALIDATION_PROVIDER,
  YDB_CORE_SCOPE,
  YDB_ORM_SCOPE,
  DEFAULT_CONNECTION_NAME,
  getScopedToken,
} from './constants.js';
import type { YdbExecutor, YdbModuleOptions } from '../core/interfaces.js';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import {
  getEntityRuntime,
  restoreEntityRuntime,
  snapshotEntityRuntime,
} from '../entity/entity-runtime.js';
import { getActiveRecordInitToken } from './repository-token.js';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import {
  validateEntityMetadataIssues,
  validationIssuesToMessages,
} from '../metadata/validate-entity.js';
import {
  requestEntitiesForApp,
  type YdbEntityAppScope,
} from '../metadata/entity-registry.js';
import {
  claimEntitiesForScopeWithTracking,
  releaseEntitiesFromScope,
  type YdbOrmScope,
} from '../core/orm-scope.js';
import { getOrCreateRepository } from '../repository/repository-resolver.js';

/**
 * Provider that, on module initialization, wires the executor and the
 * optional encryption/blind-index providers of ITS OWN configuration (#199)
 * to the Active Record entity (see YdbBaseEntity.setExecutor /
 * setEncryptionProvider). Validates the entity metadata beforehand
 * (validateEntityMetadataIssues). Also creates the `YdbRepository` for the
 * entity and stores it in the entity runtime.
 *
 * connectionName selects the configuration (#199): 'default' — the previous
 * global DI tokens, a named configuration — its own tokens.
 */
export function createActiveRecordEntityProvider(
  entityClass: typeof YdbBaseEntity,
  connectionName: string = DEFAULT_CONNECTION_NAME,
): Provider {
  return {
    provide: getActiveRecordInitToken(entityClass, connectionName),
    useFactory: (
      db: YdbExecutor,
      opts: YdbModuleOptions,
      encryptionProvider?: YdbEncryptionProvider,
      blindIndexProvider?: YdbBlindIndexProvider,
      validationProvider?: YdbValidationProvider,
      entityScope?: YdbEntityAppScope,
      ormScope?: YdbOrmScope,
    ) => {
      // forFeature explicitly declares the entities of THIS application (#142):
      // the @YdbEntity decorator already ran on the first import of the
      // class and won't run again (module cache). The scope arrives through
      // the YDB_CORE_SCOPE DI token from this application's container, so
      // the binding stays correct regardless of provider resolution order
      // and never touches foreign applications.
      if (entityScope) {
        requestEntitiesForApp(entityScope, [entityClass]);
      }

      // Validate BEFORE binding to the scope: an invalid entity gets no
      // executor/providers and leaves no ownership behind (#199 + atomicity).
      const issues = validateEntityMetadataIssues(entityClass, {
        encryptionProviderConfigured: Boolean(encryptionProvider),
        blindIndexProviderConfigured: Boolean(blindIndexProvider),
      });
      if (issues.length) {
        throw new Error(
          `Entity ${entityClass.name} metadata validation failed:\n` +
            validationIssuesToMessages(issues)
              .map((i) => `  - ${i}`)
              .join('\n'),
        );
      }

      // Entity ownership (#199): one class — one active configuration.
      // Registering in a foreign configuration is a deterministic error.
      // Remember newly claimed entities for a rollback on configuration
      // failure.
      let newlyClaimed: (new (...args: any[]) => any)[] = [];
      if (ormScope) {
        newlyClaimed = claimEntitiesForScopeWithTracking(ormScope, [
          entityClass,
        ]);
      }

      // Snapshot of the runtime configuration for atomic rollback on error.
      const runtimeSnapshot = snapshotEntityRuntime(entityClass);

      try {
        const runtime = getEntityRuntime(entityClass);
        runtime.uuidGenerator = opts.uuidVersion === 'v4' ? uuidv4 : uuidv7;
        // Binding to the configuration (#199): per-scope transaction settings.
        if (ormScope) {
          runtime.scope = ormScope;
          runtime.transactions = ormScope.transactions;
        }

        entityClass.setExecutor(db);
        // Providers are overwritten unconditionally: a repeated bootstrap without
        // them (tests, hot-restart) must not leave the previous
        // configuration's providers behind — undefined resets the previous
        // value.
        entityClass.setEncryptionProvider(encryptionProvider);
        entityClass.setBlindIndexProvider(blindIndexProvider);
        entityClass.setValidationProvider(validationProvider);
        entityClass.setAadFormat(opts.aadFormat);
        entityClass.setAadReadFallback(opts.aadReadFallback);

        getOrCreateRepository(entityClass as any);
      } catch (e) {
        // Roll the entity's runtime configuration back to the pre-change snapshot.
        restoreEntityRuntime(entityClass, runtimeSnapshot);
        if (ormScope && newlyClaimed.length > 0) {
          releaseEntitiesFromScope(ormScope, newlyClaimed);
        }
        throw e;
      }

      return entityClass;
    },
    inject: [
      getScopedToken(YDB_QUERY, connectionName),
      getScopedToken(YDB_OPTIONS, connectionName),
      {
        token: getScopedToken(YDB_ENCRYPTION_PROVIDER, connectionName),
        optional: true,
      },
      {
        token: getScopedToken(YDB_BLIND_INDEX_PROVIDER, connectionName),
        optional: true,
      },
      {
        token: getScopedToken(YDB_VALIDATION_PROVIDER, connectionName),
        optional: true,
      },
      // The scope is optional for robustness against exotic containers without
      // a core: without it binding is impossible, but the executor is
      // absent anyway
      { token: getScopedToken(YDB_CORE_SCOPE, connectionName), optional: true },
      { token: getScopedToken(YDB_ORM_SCOPE, connectionName), optional: true },
    ],
  };
}
