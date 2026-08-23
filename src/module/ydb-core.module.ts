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
  createCredentialsProvider,
  createDriver,
  createExecutor,
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
} from '../core/constants.js';
import {
  YdbModuleAsyncOptions,
  YdbModuleOptions,
  YdbOptionsFactory,
  YdbExecutor,
} from '../core/interfaces.js';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import { CredentialsProvider } from '@ydbjs/auth';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import { YdbTransactionManager } from '../transaction/transaction.manager.js';
import { YdbSchemaSyncer } from '../schema/schema-sync.js';
import { getRegisteredYdbEntities } from '../metadata/entity-registry.js';
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
      await this.schemaSyncer.sync(getRegisteredYdbEntities());
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

  /** Идемпотентно: снятие с учёта + закрытие созданного модулем драйвера. */
  private async dispose(
    opts: { ignoreCloseErrors?: boolean } = {},
  ): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    releaseCoreModuleInit(this.state);

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
    const state: CoreModuleState = {};
    const asyncProviders = this.createAsyncProviders(options, state);

    return {
      module: YdbCoreModule,
      imports: [...(options.imports || [])],
      providers: [
        ...asyncProviders,

        {
          provide: YDB_CREDENTIALS_PROVIDER,
          useFactory: (opts: YdbModuleOptions) => {
            try {
              return createCredentialsProvider(opts);
            } catch (error) {
              // Компиляция упала после claim — освобождаем слот,
              // чтобы следующий бутстрап в этом процессе был возможен.
              releaseCoreModuleInit(state);
              throw error;
            }
          },
          inject: [YDB_OPTIONS],
        },

        {
          provide: YDB_DRIVER,
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
          inject: [YDB_OPTIONS, YDB_CREDENTIALS_PROVIDER],
        },

        {
          provide: YDB_QUERY,
          useFactory: (driver: Driver, opts: YdbModuleOptions): YdbExecutor =>
            createExecutor(driver, opts),
          inject: [YDB_DRIVER, YDB_OPTIONS],
        },

        {
          provide: YDB_ENCRYPTION_PROVIDER,
          useFactory: (
            opts: YdbModuleOptions,
          ): YdbEncryptionProvider | undefined => opts.encryptionProvider,
          inject: [YDB_OPTIONS],
        },

        {
          provide: YDB_BLIND_INDEX_PROVIDER,
          useFactory: (
            opts: YdbModuleOptions,
          ): YdbBlindIndexProvider | undefined => opts.blindIndexProvider,
          inject: [YDB_OPTIONS],
        },

        {
          provide: YDB_VALIDATION_PROVIDER,
          useFactory: (
            opts: YdbModuleOptions,
          ): YdbValidationProvider | undefined => opts.validationProvider,
          inject: [YDB_OPTIONS],
        },

        /**
         * Синхронизатор схемы БД. Только создаётся здесь; сам sync
         * выполняется в onApplicationBootstrap (см. YdbCoreModuleLifecycle):
         * к этому моменту зарегистрированы все сущности всех модулей.
         * Провайдер экспортируется: syncer.verify() можно вызвать вручную.
         */
        {
          provide: YDB_SCHEMA_SYNC,
          useFactory: (
            driver: Driver,
            executor: YdbExecutor,
          ): YdbSchemaSyncer => new YdbSchemaSyncer(driver, executor),
          inject: [YDB_DRIVER, YDB_QUERY],
        },

        {
          provide: YDB_CORE_LIFECYCLE,
          useFactory: (syncer: YdbSchemaSyncer) =>
            new YdbCoreModuleLifecycle(state, syncer),
          inject: [YDB_SCHEMA_SYNC],
        },

        YdbTransactionManager,
      ],
      exports: [
        YDB_OPTIONS,
        YDB_DRIVER,
        YDB_QUERY,
        YdbTransactionManager,
        YDB_ENCRYPTION_PROVIDER,
        YDB_BLIND_INDEX_PROVIDER,
        YDB_VALIDATION_PROVIDER,
        YDB_SCHEMA_SYNC,
      ],
    };
  }

  private static createAsyncProviders(
    options: YdbModuleAsyncOptions,
    state: CoreModuleState,
  ): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: YDB_OPTIONS,
          useFactory: async (...args: any[]) => {
            const opts = await options.useFactory!(...args);
            validateYdbModuleOptions(opts);
            claimCoreModuleInit(state);
            state.options = opts;
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
        provide: YDB_OPTIONS,
        useFactory: async (optionsFactory: YdbOptionsFactory) => {
          const opts = await optionsFactory.createYdbOptions();
          validateYdbModuleOptions(opts);
          claimCoreModuleInit(state);
          state.options = opts;
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
