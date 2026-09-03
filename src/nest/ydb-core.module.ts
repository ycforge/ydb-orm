import {
  DynamicModule,
  Global,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Provider,
  Type,
} from '@nestjs/common';
import { Driver } from '@ydbjs/core';
import {
  createDriver,
  createExecutor,
  resolveCredentialsProvider,
  validateYdbModuleOptions,
} from '../core/driver.js';
import {
  YDB_DRIVER,
  YDB_QUERY,
  YDB_OPTIONS,
  YDB_CREDENTIALS_PROVIDER,
  YDB_ENCRYPTION_PROVIDER,
  YDB_BLIND_INDEX_PROVIDER,
  YDB_VALIDATION_PROVIDER,
  YDB_SCHEMA_SYNC,
  YDB_CORE_LIFECYCLE,
  YDB_CORE_SCOPE,
  YDB_ORM_SCOPE,
  YDB_CONNECTION_NAME,
  DEFAULT_CONNECTION_NAME,
  getScopedToken,
  getTransactionManagerToken,
} from './constants.js';
import { YdbModuleAsyncOptions, YdbOptionsFactory } from './interfaces.js';
import type { YdbModuleOptions, YdbExecutor } from '../core/interfaces.js';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import { CredentialsProvider } from '@ydbjs/auth';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import { YdbTransactionManager } from '../transaction/transaction.manager.js';
import { configureTransactionContext } from '../transaction/transaction-context.js';
import { YdbSchemaSyncer } from '../schema/schema-sync.js';
import {
  createEntityScope,
  getRegisteredYdbEntities,
} from '../metadata/entity-registry.js';
import {
  createOrmScope,
  getDefaultOrmScope,
  releaseOrmScope,
} from '../core/orm-scope.js';
import {
  claimCoreModuleInit,
  releaseCoreModuleInit,
  CoreModuleState,
} from './core-module-registry.js';

/**
 * Internal core lifecycle provider (#93).
 *
 * - onApplicationBootstrap: schema sync (if `sync: true`). The hook runs
 *   after all modules are compiled and every `forFeature` entity received
 *   its executor — the initialization order is deterministic, the result
 *   no longer depends on the import order of entities. A DDL error
 *   propagates from app.init() as the original schema error, not as an
 *   obscure DI-factory failure. DDL races between replicas are not solved
 *   at this level — safety is ensured by schema sync itself (DescribeTable
 *   before each DDL).
 *
 * - onApplicationShutdown: unregisters the instance (see
 *   core-module-registry) and closes the driver created by the module
 *   itself. A driver passed from outside (overrideProvider/useValue) is
 *   not closed — the caller owns it. Repeated shutdown is safe
 *   (idempotent).
 */
class YdbCoreModuleLifecycle
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private disposed = false;

  constructor(
    private readonly state: CoreModuleState,
    private readonly schemaSyncer: YdbSchemaSyncer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.state.options?.sync) return;
    try {
      // Sync only sees the entities of THIS application (#142): those bound
      // by this container's forFeature providers through YDB_CORE_SCOPE.
      await this.schemaSyncer.sync(
        getRegisteredYdbEntities(this.state.entityScope),
      );
    } catch (error) {
      // After a failed bootstrap the application never started: unregister the
      // instance and close the driver right away — NestJS only calls the
      // shutdown hooks on a successful init(), otherwise the initialization
      // slot would stay occupied forever. The original schema error
      // propagates up.
      await this.dispose({ ignoreCloseErrors: true });
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dispose();
  }

  /** Idempotent: unregister + release the entity scope (#199)
   * + close the module-created driver. */
  private async dispose(
    opts: { ignoreCloseErrors?: boolean } = {},
  ): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    releaseCoreModuleInit(this.state);
    // The configuration's entities are released: after shutdown they can be
    // claimed by another configuration (#199).
    releaseOrmScope(this.state.ormScope);

    const driver = this.state.ownedDriver;
    if (!driver) return;
    try {
      // Driver close() is synchronous (void), but a custom driverFactory may
      // return a driver with async closing — wait for it.
      const closing = driver.close() as unknown;
      if (closing instanceof Promise) {
        await closing;
      }
    } catch (error) {
      if (!opts.ignoreCloseErrors) throw error;
      // On a failed bootstrap the original schema error must propagate up,
      // so the driver close error is only logged.
      console.error(
        'Failed to close YDB driver after failed bootstrap:',
        (error as Error)?.message ?? error,
      );
    }
  }
}

@Global()
@Module({})
export class YdbCoreModule {
  /**
   * Registers one named YDB configuration (#199): creates the driver, the
   * YdbExecutor (via query(driver)) and the credentials provider — from
   * `auth` (AuthManager from @ycforge/auth) or an explicit
   * credentialsProvider / driverOptions.credentialsProvider (conflicting
   * sources → error). Optional encryption/blind-index/validation providers
   * are lifted from the options; schema sync runs at bootstrap when
   * `sync: true`.
   *
   * @param options - async module options (useFactory/useClass/useExisting)
   */
  static forRootAsync(options: YdbModuleAsyncOptions): DynamicModule {
    // The module instance state: lives in the providers' closure; the
    // claim/release and driver-ownership accounting operate on it. The
    // entity scope is created here too — one per DynamicModule instance:
    // forFeature providers bind entities to it via the YDB_CORE_SCOPE DI
    // token and don't depend on provider resolution order (#142).
    // Configuration name (#199): configurations with different names
    // coexist in one process, their DI tokens are separated via
    // getScopedToken.
    const name = options.name ?? DEFAULT_CONNECTION_NAME;
    if (!name) {
      throw new Error(
        'YdbCoreModule.forRootAsync(): "name" must be a non-empty string.',
      );
    }
    const tokens = {
      options: getScopedToken(YDB_OPTIONS, name),
      driver: getScopedToken(YDB_DRIVER, name),
      query: getScopedToken(YDB_QUERY, name),
      credentials: getScopedToken(YDB_CREDENTIALS_PROVIDER, name),
      encryption: getScopedToken(YDB_ENCRYPTION_PROVIDER, name),
      blindIndex: getScopedToken(YDB_BLIND_INDEX_PROVIDER, name),
      validation: getScopedToken(YDB_VALIDATION_PROVIDER, name),
      schemaSync: getScopedToken(YDB_SCHEMA_SYNC, name),
      coreScope: getScopedToken(YDB_CORE_SCOPE, name),
      ormScope: getScopedToken(YDB_ORM_SCOPE, name),
      lifecycle: getScopedToken(YDB_CORE_LIFECYCLE, name),
      transactionManager: getTransactionManagerToken(name),
    };
    const state: CoreModuleState = {
      entityScope: createEntityScope(),
      name,
      // The default configuration uses a process-singleton scope: a repeated
      // bootstrap (tests, hot-restart) with the same entities is an
      // idempotent claim, as before. Two live instances named 'default'
      // cannot exist at once (claimCoreModuleInit), so sharing the scope is
      // safe. Named configurations are isolated.
      ormScope:
        name === DEFAULT_CONNECTION_NAME
          ? getDefaultOrmScope()
          : createOrmScope(name),
    };
    const asyncProviders = this.createAsyncProviders(
      options,
      state,
      tokens.options,
    );

    return {
      module: YdbCoreModule,
      imports: [...(options.imports || [])],
      providers: [
        ...asyncProviders,

        {
          // Configuration name (#199): the useValue string makes this
          // DynamicModule's module token unique per name — otherwise NestJS
          // deduplicates two forRootAsync calls of the same class into one
          // module.
          provide: YDB_CONNECTION_NAME,
          useValue: name,
        },

        {
          provide: tokens.coreScope,
          useValue: state.entityScope,
        },

        {
          provide: tokens.ormScope,
          useValue: state.ormScope,
        },

        {
          // Credentials provider (#96): an explicit opts.credentialsProvider
          // is used as-is; otherwise auth (AuthManager from @ycforge/auth);
          // otherwise driverOptions.credentialsProvider.
          provide: tokens.credentials,
          useFactory: (opts: YdbModuleOptions) => {
            try {
              return resolveCredentialsProvider(opts);
            } catch (error) {
              // Compilation failed after the claim — release the slot so a
              // later bootstrap in this process is possible.
              releaseCoreModuleInit(state);
              throw error;
            }
          },
          inject: [tokens.options],
        },

        {
          provide: tokens.driver,
          useFactory: async (
            opts: YdbModuleOptions,
            credentialsProvider: CredentialsProvider,
          ) => {
            try {
              // driverFactory is a custom creation path (tests / non-standard
              // transports); such a driver is also considered created by the
              // module and is closed on shutdown.
              const driver =
                opts.driverFactory !== undefined
                  ? await opts.driverFactory()
                  : await createDriver(opts, credentialsProvider);
              state.ownedDriver = driver;
              return driver;
            } catch (error) {
              releaseCoreModuleInit(state);
              throw error;
            }
          },
          inject: [tokens.options, tokens.credentials],
        },

        {
          provide: tokens.query,
          useFactory: (driver: Driver, opts: YdbModuleOptions): YdbExecutor =>
            createExecutor(driver, opts),
          inject: [tokens.driver, tokens.options],
        },

        {
          provide: tokens.encryption,
          useFactory: (
            opts: YdbModuleOptions,
          ): YdbEncryptionProvider | undefined => opts.encryptionProvider,
          inject: [tokens.options],
        },

        {
          provide: tokens.blindIndex,
          useFactory: (
            opts: YdbModuleOptions,
          ): YdbBlindIndexProvider | undefined => opts.blindIndexProvider,
          inject: [tokens.options],
        },

        {
          provide: tokens.validation,
          useFactory: (
            opts: YdbModuleOptions,
          ): YdbValidationProvider | undefined => opts.validationProvider,
          inject: [tokens.options],
        },

        /**
         * DB schema synchronizer. Only created here; the actual sync runs in
         * onApplicationBootstrap (see YdbCoreModuleLifecycle): by then all
         * entities of all modules are registered. The provider is exported:
         * syncer.verify() can be called manually.
         */
        {
          provide: tokens.schemaSync,
          useFactory: (
            driver: Driver,
            executor: YdbExecutor,
          ): YdbSchemaSyncer => new YdbSchemaSyncer(driver, executor),
          inject: [tokens.driver, tokens.query],
        },

        {
          provide: tokens.lifecycle,
          useFactory: (syncer: YdbSchemaSyncer) =>
            new YdbCoreModuleLifecycle(state, syncer),
          inject: [tokens.schemaSync],
        },

        {
          // The configuration's transaction manager (#199): its settings come
          // from its scope, not from process-global ones.
          provide: tokens.transactionManager,
          useFactory: (db: YdbExecutor) =>
            new YdbTransactionManager(db, state.ormScope.transactions),
          inject: [tokens.query],
        },
      ],
      exports: [
        tokens.options,
        tokens.driver,
        tokens.query,
        tokens.transactionManager,
        tokens.credentials,
        tokens.encryption,
        tokens.blindIndex,
        tokens.validation,
        tokens.schemaSync,
        tokens.coreScope,
        tokens.ormScope,
      ],
    };
  }

  private static createAsyncProviders(
    options: YdbModuleAsyncOptions,
    state: CoreModuleState,
    optionsToken: symbol,
  ): Provider[] {
    // Transaction settings (#98/#199): for the default configuration — as
    // before, process-global (even if YDB_QUERY is overridden externally,
    // the ambient/warn configuration isn't lost); for any configuration —
    // into its scope, where the forFeature AR providers and the transaction
    // manager will take them from.
    const applyTransactions = (opts: YdbModuleOptions): void => {
      if (state.name === DEFAULT_CONNECTION_NAME) {
        configureTransactionContext(opts.transactions);
      }
      state.ormScope.transactions = {
        ambient: opts.transactions?.ambient ?? false,
        warnOutsideTransaction:
          opts.transactions?.warnOutsideTransaction ?? false,
      };
    };

    if (options.useFactory) {
      return [
        {
          provide: optionsToken,
          useFactory: async (...args: any[]) => {
            const opts = await options.useFactory!(...args);
            validateYdbModuleOptions(opts);
            claimCoreModuleInit(state);
            state.options = opts;
            applyTransactions(opts);
            return opts;
          },
          inject: options.inject || [],
        },
      ];
    }

    if (!options.useClass && !options.useExisting) {
      throw new Error(
        'YdbCoreModule.forRootAsync() requires one of: useFactory, useClass, useExisting',
      );
    }

    const inject = [
      (options.useExisting || options.useClass) as Type<YdbOptionsFactory>,
    ];

    return [
      {
        provide: optionsToken,
        useFactory: async (optionsFactory: YdbOptionsFactory) => {
          const opts = await optionsFactory.createYdbOptions();
          validateYdbModuleOptions(opts);
          claimCoreModuleInit(state);
          state.options = opts;
          applyTransactions(opts);
          return opts;
        },
        inject,
      },
      ...(options.useClass
        ? [{ provide: options.useClass, useClass: options.useClass }]
        : []),
    ];
  }
}
