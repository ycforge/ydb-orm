import { ModuleMetadata, Type } from '@nestjs/common';
import { Driver, DriverOptions } from '@ydbjs/core';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
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
  /**
   * Кастомная фабрика драйвера: если задана, используется вместо создания
   * Driver по endpoint/driverOptions. Удобно для тестов и нестандартных
   * транспортов. Драйвер, возвращённый фабрикой, считается принадлежащим
   * модулю: при graceful shutdown модуль закроет его через driver.close().
   */
  driverFactory?: () => Driver | Promise<Driver>;
  driverOptions?: DriverOptions;
  poolOptions?: {
    minSize?: number;
    maxSize?: number;
    sessionTimeout?: number;
  };
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  /**
   * Провайдер валидации сущностей перед записью (save/insert/insertMany/update).
   * Например, ClassValidatorProvider. Без него валидация не выполняется.
   */
  validationProvider?: YdbValidationProvider;
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
  /**
   * Настройки транзакций (#98):
   * - ambient — включить ambient-контекст транзакций (AsyncLocalStorage):
   *   операции репозиториев внутри runInTransaction() без явного { trx }
   *   автоматически используют активную транзакцию. По умолчанию выключено.
   * - warnOutsideTransaction — предупреждать (console.warn), когда запрос
   *   выполняется вне какой бы то ни было транзакции. По умолчанию выключено
   *   (чтобы не шуметь); включайте осознанно, например в dev-окружении.
   */
  transactions?: YdbTransactionsSettings;
}

export interface YdbTransactionsSettings {
  ambient?: boolean;
  warnOutsideTransaction?: boolean;
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

/**
 * Уровень изоляции транзакции YDB (см. TransactionExecuteOptions в @ydbjs/query).
 */
export type YdbIsolationLevel =
  'serializableReadWrite' | 'snapshotReadOnly' | 'snapshotReadWrite';

/**
 * Опции исполнения транзакции (#98).
 *
 * - isolation — уровень изоляции YDB (по умолчанию 'serializableReadWrite' на
 *   стороне SDK);
 * - signal — AbortSignal для отмены транзакции;
 * - timeout — таймаут в миллисекундах; реализуется ORM через AbortSignal,
 *   объединённый с переданным signal (AbortSignal.any);
 * - idempotent — разрешить SDK повторять тело транзакции при retryable-
 *   ошибках. ВНИМАНИЕ: при повторе заново выполняется весь колбэк, поэтому
 *   побочные эффекты и lifecycle hooks могут сработать больше одного раза.
 */
export interface YdbTransactionOptions {
  isolation?: YdbIsolationLevel;
  signal?: AbortSignal;
  timeout?: number;
  idempotent?: boolean;
}

/** Хэндл открытой (открываемой) транзакции. */
export interface YdbTransactionHandle {
  execute<T>(
    fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

export interface YdbExecutor {
  (strings: TemplateStringsArray, ...args: any[]): YdbQuery;
  transaction(options?: YdbTransactionOptions): YdbTransactionHandle;
}
