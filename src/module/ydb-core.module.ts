import { DynamicModule, Global, Module, Provider, Type } from '@nestjs/common';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import {
  YDB_DRIVER,
  YDB_QUERY,
  YDB_OPTIONS,
  YDB_CREDENTIALS_PROVIDER,
  YDB_ENCRYPTION_PROVIDER,
  YDB_BLIND_INDEX_PROVIDER,
  YDB_SCHEMA_SYNC,
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
import { AuthKeyCredentialsProvider } from '../credentials/auth-key-credentials-provider.js';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';
import { CredentialsProvider } from '@ydbjs/auth';
import { YdbTransactionManager } from '../transaction/transaction.manager.js';
import { YdbSchemaSyncer } from '../schema/schema-sync.js';
import { getRegisteredYdbEntities } from '../metadata/entity-registry.js';

@Global()
@Module({})
export class YdbCoreModule {
  static forRootAsync(options: YdbModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);

    return {
      module: YdbCoreModule,
      imports: [...(options.imports || [])],
      providers: [
        ...asyncProviders,
        YdbTransactionManager,

        {
          provide: YDB_CREDENTIALS_PROVIDER,
          useFactory: (opts: YdbModuleOptions) => {
            switch (opts.auth_type) {
              case 'meta':
                return new MetadataCredentialsProvider();
              case 'auth_key':
                if (!opts.authOptions.authorized_key_path) {
                  throw new Error('Authorized key path not provided');
                }
                return AuthKeyCredentialsProvider.fromAuthorizedKeyFile(
                  opts.authOptions.authorized_key_path,
                );
              case 'anonymous':
                return new AnonymousCredentialsProvider();
              default:
                throw new Error(
                  `Invalid YDB auth type: ${String(opts.auth_type)}. ` +
                    `Supported: "meta", "auth_key", "anonymous".`,
                );
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
            const driver = new Driver(opts.endpoint, {
              credentialsProvider,
              ...opts.driverOptions,
            });
            await driver.ready();
            return driver;
          },
          inject: [YDB_OPTIONS, YDB_CREDENTIALS_PROVIDER],
        },

        {
          provide: YDB_QUERY,
          useFactory: (driver: Driver, opts: YdbModuleOptions): YdbExecutor =>
            query(driver, {
              poolOptions: opts.poolOptions
                ? Object.fromEntries(
                    Object.entries(opts.poolOptions).filter(
                      ([, v]) => v !== undefined,
                    ),
                  )
                : undefined,
            }) as unknown as YdbExecutor,
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

        /**
         * Синхронизатор схемы БД. При `sync: true` в опциях модуля
         * дожидается создания драйвера и подстраивает схему под все
         * зарегистрированные сущности до старта приложения.
         * Провайдер экспортируется: syncer.verify() можно вызвать вручную.
         */
        {
          provide: YDB_SCHEMA_SYNC,
          useFactory: async (
            opts: YdbModuleOptions,
            driver: Driver,
            executor: YdbExecutor,
          ): Promise<YdbSchemaSyncer> => {
            const syncer = new YdbSchemaSyncer(driver, executor);
            if (opts.sync) {
              await syncer.sync(getRegisteredYdbEntities());
            }
            return syncer;
          },
          inject: [YDB_OPTIONS, YDB_DRIVER, YDB_QUERY],
        },
      ],
      exports: [
        YDB_DRIVER,
        YDB_QUERY,
        YdbTransactionManager,
        YDB_ENCRYPTION_PROVIDER,
        YDB_BLIND_INDEX_PROVIDER,
        YDB_SCHEMA_SYNC,
      ],
    };
  }

  private static createAsyncProviders(
    options: YdbModuleAsyncOptions,
  ): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: YDB_OPTIONS,
          useFactory: options.useFactory,
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
        useFactory: async (optionsFactory: YdbOptionsFactory) =>
          optionsFactory.createYdbOptions(),
        inject,
      },
      ...(options.useClass
        ? [{ provide: options.useClass, useClass: options.useClass }]
        : []),
    ];
  }
}
