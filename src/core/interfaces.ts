import { ModuleMetadata, Type } from '@nestjs/common';
import { DriverOptions } from '@ydbjs/core';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { QueryLogger } from './query-logger.js';

export type { QueryOptions } from './query-options.js';
export type { QueryLogger, QueryLogEntry } from './query-logger.js';

export interface YdbAuthOptions {
  authorized_key_path?: string;
}

export type YdbAuthMethod = 'meta' | 'anonymous' | 'auth_key';

export interface YdbModuleOptions {
  endpoint: string;
  auth_type?: YdbAuthMethod;
  authOptions: YdbAuthOptions;
  driverOptions?: DriverOptions;
  poolOptions?: {
    minSize?: number;
    maxSize?: number;
    sessionTimeout?: number;
  };
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  /**
   * Версия генерируемых UUID для первичных ключей: v7 (по умолчанию,
   * время-сортируемые) или v4 (случайные, для переходного периода).
   */
  uuidVersion?: 'v4' | 'v7';
  /**
   * Как в TypeORM synchronize: при старте приложения подстроить схему БД
   * под метаданные всех сущностей (создать недостающие таблицы и колонки).
   * Только для dev-стендов — в проде используйте миграции.
   */
  sync?: boolean;
  /**
   * Логирование запросов: true (консоль по умолчанию) или экземпляр QueryLogger.
   * Логирует SQL, замаскированные параметры и длительность.
   */
  logQueries?: boolean | QueryLogger;
}

export interface YdbOptionsFactory {
  createYdbOptions(): Promise<YdbModuleOptions> | YdbModuleOptions;
}

export interface YdbModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory?: (...args: any[]) => Promise<YdbModuleOptions> | YdbModuleOptions;
  inject?: any[];
  useClass?: Type<YdbOptionsFactory>;
  useExisting?: Type<YdbOptionsFactory>;
}

export interface YdbQuery {
  parameter(name: string, value: unknown): YdbQuery;
  timeout(timeout: number): YdbQuery;
  signal(signal: AbortSignal): YdbQuery;
  cancel(): YdbQuery;
  then: Promise<any>['then'];
}

export interface YdbExecutor {
  (strings: TemplateStringsArray, ...args: any[]): YdbQuery;
  transaction(): {
    execute<T>(fn: (trx: YdbExecutor) => Promise<T>): Promise<T>;
  };
}
