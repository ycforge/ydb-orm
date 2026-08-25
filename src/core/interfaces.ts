import { ModuleMetadata, Type } from '@nestjs/common';
import { Driver, DriverOptions } from '@ydbjs/core';
import type { CredentialsProvider } from '@ydbjs/auth';
import type { AuthManager } from '@ycforge/auth';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import type { QueryLogger } from './query-logger.js';
import type { YdbRetryPolicyInput } from './retry.js';
import type { OrmAdapter } from '../adapters/adapter.js';

export type { QueryOptions } from './query-options.js';
export type { QueryLogger, QueryLogEntry } from './query-logger.js';

export interface YdbModuleOptions {
  endpoint: string;
  /**
   * Готовый CredentialsProvider (#96) — паттерн useExisting: передаётся
   * как есть (OAuth-токен, тестовые реализации, переиспользование
   * провайдера из другого модуля).
   *
   * Приоритет источников провайдера (детерминированный, см.
   * resolveCredentialsProvider):
   *   credentialsProvider → auth (AuthManager из @ycforge/auth) →
   *   DI-провайдер YDB_CREDENTIALS_PROVIDER →
   *   driverOptions.credentialsProvider.
   * Задание одновременно credentialsProvider и
   * driverOptions.credentialsProvider — ошибка конфигурации:
   * молчаливый выбор одного из них запрещён.
   */
  credentialsProvider?: CredentialsProvider;
  /**
   * Готовый AuthManager из пакета `@ycforge/auth` — единая точка
   * стратегий аутентификации (iam_token / metadata / auth_key /
   * access_token / anonymous / static). Адаптируется в CredentialsProvider
   * через `createYdbCredentialsProvider(auth, YDB_AUTH_USAGE, options)` из
   * `@ycforge/auth/ydb`.
   *
   * Приоритет: сразу после явного `credentialsProvider` и перед
   * DI-провайдером `YDB_CREDENTIALS_PROVIDER` /
   * `driverOptions.credentialsProvider`.
   * Задание одновременно `auth` и `driverOptions.credentialsProvider` —
   * ошибка конфигурации (`Conflicting YDB credentials configuration`).
   */
  auth?: AuthManager;
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
  /**
   * Retry-политика по типу ошибки (#27) для операций executor'а.
   *
   * - `undefined` / `false` (по умолчанию) — политика выключена: повторами
   *   одиночных запросов владеет только внутренний ретрай SDK (как в #98);
   * - `true` — политика с дефолтами (maxAttempts: 3, bounded backoff
   *   100..5000 мс, jitter 0.25);
   * - объект `YdbRetryPolicyOptions` — кастомная политика.
   *
   * ПРАВИЛО ИДЕМПОТЕНТНОСТИ (fail-safe): политика повторяет только
   * запросы, явно помеченные идемпотентными — `.idempotent(true)` на
   * цепочке или `{ idempotent: true }` в QueryOptions. Непомеченный
   * запрос (включая все записи по умолчанию) выполняется ровно один раз:
   * внутренний цикл SDK гасится, двусмысленный сбой транспорта не
   * приводит к повтору записи. Для транзакций — отдельная опция retry
   * в runInTransaction() (колбэк обязан быть идемпотентным, #98).
   * Когда политика включена и запрос помечен, ORM владеет ретраями
   * через этот executor и ГАСИТ внутренний цикл SDK (одна попытка SDK
   * на попытку ORM) — попытки не перемножаются. Статусы повтора:
   * только ABORTED/UNAVAILABLE/OVERLOADED. См. README «Retry-политика».
   */
  retry?: YdbRetryPolicyInput;
  /**
   * Адаптер СУБД (см. OrmAdapter в adapters/adapter.ts): реализация
   * подключения, маппинга значений, retry-политики и schema sync.
   * По умолчанию — встроенный ydbAdapter. Переопределяйте только для
   * нестандартных транспортов/тестовых стендов; публичные имена API
   * (YdbEntity, YdbRepository, mapToYdb и т.д.) от адаптера не зависят.
   */
  adapter?: OrmAdapter;
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
  /**
   * Пометка идемпотентности одиночного запроса (#27): разрешает
   * retry-политике ORM (и условно-retryable статусам SDK) повторять
   * этот запрос. По умолчанию запросы НЕ считаются идемпотентными:
   * без пометки политика ORM выполняет запрос ровно один раз.
   */
  idempotent(flag?: boolean): YdbQuery;
  cancel(): YdbQuery;
  /**
   * SDK-события запроса (#27): у реального Query из @ydbjs/query есть
   * `.on('retry', ctx)` — политика ORM использует его, чтобы гасить
   * внутренний ретрай SDK и забирать управление повторами себе.
   * Опционально: моки и другие реализации могут её не предоставлять.
   */
  on?(
    event: 'retry',
    listener: (ctx: { attempt: number; error: unknown }) => void,
  ): unknown;
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
 * - signal — ГЛОБАЛЬНЫЙ AbortSignal: отменяет операцию целиком, все попытки
 *   (включая idempotent-retry); пробрасывается в SDK как есть;
 * - timeout — таймаут в миллисекундах, действует НА КАЖДУЮ ПОПЫТКУ: при
 *   idempotent-retry каждая попытка получает СВЕЖЕЕ окно таймаута, а не
 *   истёкший дедлайн первой попытки. Полный дедлайн на всю операцию задаётся
 *   явно: signal: AbortSignal.timeout(ms);
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
