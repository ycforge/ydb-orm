import { Driver, DriverOptions } from '@ydbjs/core';
import type { CredentialsProvider } from '@ydbjs/auth';
import type { AuthManager } from '@ycforge/auth';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { AadFormat } from '../encryption/aad.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import type { QueryLogger, YdbLogParamValues } from './query-logger.js';
import type { YdbRetryPolicyInput } from './retry.js';

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
   * Формат сериализации Security AAD (#165): 'v2' (по умолчанию) — каноническая
   * self-delimiting сериализация без коллизий от вложенных разделителей, или
   * 'legacy' — исторический `name=value;...` ТОЛЬКО для переходного периода:
   * смена формата меняет аутентифицированные байты, поэтому старый ciphertext
   * под v2 не расшифруется. Миграция: пока в БД есть записи, написанные в
   * legacy, читайте/шифруйте в 'legacy' и перешифруйте их (save/скрипт),
   * затем переключитесь на 'v2'.
   */
  aadFormat?: AadFormat;
  /**
   * Автоматическое определение формата Security AAD при дешифровке (#165):
   * true (по умолчанию) — при сбое расшифровки основным форматом пробуется
   * второй. Это единственный безопасный путь апгрейда существующей БД:
   * строки, написанные до появления `v2`, остаются читаемыми после смены
   * дефолта. false — строгий режим, пригодный только после того, как все
   * данные перешифрованы в один формат (сбой формата падает сразу).
   * Поля с `aadOverride` от падения формата не зависят — повтор не делается.
   */
  aadReadFallback?: boolean;
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
   * Логирует SQL, имена параметров, безопасную метаинформацию значений
   * (тип и класс размера, raw скрыт по умолчанию) и длительность.
   */
  logQueries?: boolean | QueryLogger;
  /**
   * Раскрытие raw-значений параметров в логах (#168). По умолчанию
   * (undefined/false) значения не логируются вовсе — только безопасная
   * метаинформация (тип и укрупнённый класс размера, например
   * `<string:1-31>` или `<bytes:128-511>`; точная длина скрыта), поэтому
   * чувствительные данные с произвольными именами не попадают в журналы.
   * «Значения скрыты по умолчанию» — intentional behavior change c 1.0.
   * raw-раскрытие — явный opt-in: true (все значения), string[] / RegExp /
   * предикат (только подходящие имена параметров). Бинарные значения
   * маскируются всегда, даже при `true`.
   */
  logParamValues?: YdbLogParamValues;
  /**
   * Настройки транзакций (#98):
   * - ambient — включить ambient-контекст транзакций (AsyncLocalStorage):
   *   операции репозиториев внутри runInTransaction() без явного { trx }
   *   автоматически используют активную транзакцию. По умолчанию выключено.
   * - warnOutsideTransaction — предупреждать, когда запрос выполняется вне
   *   какой бы то ни было транзакции. Предупреждение уходит в логгер (#206):
   *   в `QueryLogger.warn` (опция `logQueries`) или в консольный фолбэк
   *   `ConsoleQueryLogger`, если кастомный логгер не настроен. По умолчанию
   *   выключено (чтобы не шуметь); включайте осознанно, например в dev-окружении.
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
}

export interface YdbTransactionsSettings {
  ambient?: boolean;
  warnOutsideTransaction?: boolean;
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
