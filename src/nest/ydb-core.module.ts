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
 * Внутренний lifecycle-провайдер ядра (#93).
 *
 * - onApplicationBootstrap: schema sync (если `sync: true`). Хук выполняется
 *   после того, как все модули скомпилированы и все `forFeature`-сущности
 *   получили executor — порядок инициализации детерминирован, результат
 *   больше не зависит от порядка импортов сущностей. Ошибка DDL пробрасывается
 *   из app.init() как исходная ошибка схемы, а не как невнятный сбой DI-фабрики.
 *   Гонки DDL между репликами не решаются на этом уровне — безопасность
 *   обеспечивает сам schema sync (DescribeTable перед каждым DDL).
 *
 * - onApplicationShutdown: снимает экземпляр с учёта (см. core-module-registry)
 *   и закрывает драйвер, созданный самим модулем. Драйвер, переданный снаружи
 *   (overrideProvider/useValue), не закрывается — им владеет вызывающий.
 *   Повторный shutdown безопасен (идемпотентен).
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
      // Sync видит только сущности СВОЕГО приложения (#142): привязанные
      // провайдерами forFeature этого контейнера через YDB_CORE_SCOPE.
      await this.schemaSyncer.sync(
        getRegisteredYdbEntities(this.state.entityScope),
      );
    } catch (error) {
      // После неудачного бутстрапа приложение не стартовало: снимаем
      // экземпляр с учёта и закрываем драйвер сразу — NestJS вызывает
      // shutdown-хуки только при успешном init(), иначе слот инициализации
      // остался бы занят навсегда. Наверх идёт исходная ошибка схемы.
      await this.dispose({ ignoreCloseErrors: true });
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dispose();
  }

  /** Идемпотентно: снятие с учёта + освобождение скоупа сущностей (#199)
   * + закрытие созданного модулем драйвера. */
  private async dispose(
    opts: { ignoreCloseErrors?: boolean } = {},
  ): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    releaseCoreModuleInit(this.state);
    // Сущности конфигурации освобождаются: после shutdown их можно
    // привязать к другой конфигурации (#199).
    releaseOrmScope(this.state.ormScope);

    const driver = this.state.ownedDriver;
    if (!driver) return;
    try {
      // close() у драйвера синхронный (void), но кастомная driverFactory
      // может вернуть драйвер с асинхронным закрытием — дожидаемся его.
      const closing = driver.close() as unknown;
      if (closing instanceof Promise) {
        await closing;
      }
    } catch (error) {
      if (!opts.ignoreCloseErrors) throw error;
      // При падении бутстрапа наверх должна идти исходная ошибка схемы,
      // поэтому ошибку закрытия драйвера только логируем.
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
  static forRootAsync(options: YdbModuleAsyncOptions): DynamicModule {
    // Состояние конкретного экземпляра модуля: живёт в замыкании провайдеров,
    // по нему выполняется claim/release и учитывается владение драйвером.
    // Скоуп сущностей создаётся здесь же — один на экземпляр DynamicModule:
    // провайдеры forFeature привязывают сущности к нему через DI-токен
    // YDB_CORE_SCOPE и не зависят от порядка резолва (#142).
    // Имя конфигурации (#199): конфигурации с разными именами сосуществуют
    // в одном процессе, их DI-токены разнесены через getScopedToken.
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
      // Дефолтная конфигурация использует процессный синглтон-скоуп:
      // повторный бутстрап (тесты, hot-restart) с теми же сущностями —
      // идемпотентный claim, как раньше. Одновременно живых экземпляров
      // с именем 'default' быть не может (claimCoreModuleInit), поэтому
      // общий скоуп безопасен. Именованные конфигурации — изолированы.
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
          // Имя конфигурации (#199): useValue-строка делает module token
          // этого DynamicModule уникальным для каждого имени — иначе NestJS
          // дедуплицирует два forRootAsync одного класса в один модуль.
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
          // Провайдер учётных данных (#96): явный opts.credentialsProvider
          // используется как есть; иначе auth (AuthManager из @ycforge/auth);
          // иначе driverOptions.credentialsProvider.
          provide: tokens.credentials,
          useFactory: (opts: YdbModuleOptions) => {
            try {
              return resolveCredentialsProvider(opts);
            } catch (error) {
              // Компиляция упала после claim — освобождаем слот,
              // чтобы следующий бутстрап в этом процессе был возможен.
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
              // driverFactory — кастомное создание (тесты/нестандартные
              // транспорты); такой драйвер тоже считается созданным модулем
              // и закрывается при shutdown.
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
         * Синхронизатор схемы БД. Только создаётся здесь; сам sync
         * выполняется в onApplicationBootstrap (см. YdbCoreModuleLifecycle):
         * к этому моменту зарегистрированы все сущности всех модулей.
         * Провайдер экспортируется: syncer.verify() можно вызвать вручную.
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
          // Менеджер транзакций конфигурации (#199): настройки — из её
          // скоупа, а не процессно-глобальные.
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
    // Настройки транзакций (#98/#199): для дефолтной конфигурации — как
    // раньше, процессно-глобально (даже если YDB_QUERY переопределён извне,
    // конфигурация ambient/warn не теряется); для любой конфигурации — в её
    // скоуп, откуда их заберут AR-провайдеры forFeature и менеджер транзакций.
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
