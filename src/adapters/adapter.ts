import type { Driver } from '@ydbjs/core';
import type { CredentialsProvider } from '@ydbjs/auth';
import type { YdbExecutor, YdbModuleOptions } from '../core/interfaces.js';
import type { YdbPrimitive } from '../core/types.js';
import type {
  YdbErrorKind,
  YdbResolvedRetryPolicy,
  YdbRetryPolicyInput,
} from './ydb/retry.js';
import type { YdbSchemaSyncer } from './ydb/schema-sync.js';

/**
 * Адаптер СУБД: граница между ядром ORM и реализацией конкретной базы.
 *
 * Ядро (persistence/relations/query/migrations/transaction) опирается на
 * интерфейсы YdbExecutor/YdbQuery и не знает про SDK конкретной СУБД;
 * всю специфику (драйвер, маппинг значений, классификация ошибок,
 * retry-политика, DDL/описание схемы) инкапсулирует адаптер.
 *
 * Адаптер выбирается через опцию `adapter` в YdbModuleOptions; по умолчанию
 * используется `ydbAdapter` (src/adapters/ydb/index.ts).
 *
 * Типы намеренно остаются существующими типами проекта (Driver из
 * @ydbjs/core, CredentialsProvider из @ydbjs/auth, YdbPrimitive и т.п.) —
 * это первая фаза выноса; обобщение типов под другие СУБД — отдельная задача.
 */
export interface OrmAdapter {
  /** Имя адаптера (для диагностики и логов), например 'ydb'. */
  readonly name: string;

  // --- Подключение -------------------------------------------------------

  /**
   * Fail-fast валидация опций модуля (см. validateYdbModuleOptions).
   * `injected` — CredentialsProvider из DI (YDB_CREDENTIALS_PROVIDER).
   */
  validateModuleOptions(
    opts: YdbModuleOptions,
    injected?: CredentialsProvider,
  ): void;

  /**
   * Разрешает итоговый CredentialsProvider по приоритету источников
   * (см. resolveCredentialsProvider).
   */
  resolveCredentialsProvider(
    opts: YdbModuleOptions,
    injected?: CredentialsProvider,
  ): CredentialsProvider;

  /** Создаёт подключённый драйвер по опциям модуля (см. createDriver). */
  createDriver(
    opts: YdbModuleOptions,
    credentialsProvider?: CredentialsProvider,
  ): Promise<Driver>;

  /** Создаёт executor поверх драйвера (см. createExecutor). */
  createExecutor(driver: Driver, opts: YdbModuleOptions): YdbExecutor;

  // --- Маппинг значений ----------------------------------------------------

  /**
   * Преобразует JS-значение в значение СУБД (см. mapToYdb):
   * null → Optional<null>, undefined — ошибка, ошибки конвертации
   * оборачиваются с контекстом поля.
   */
  mapValue(type: YdbPrimitive, value: unknown, field?: string): unknown;

  // --- Retry-политика (#27) -------------------------------------------------

  /** Классификация ошибки по структурным признакам (см. classifyYdbError). */
  classifyError(error: unknown): YdbErrorKind;

  /** true, если ошибка транзитная по дефолтной политике адаптера. */
  isTransientError(error: unknown): boolean;

  /**
   * Разрешает вход политики (`boolean | options`) в полную конфигурацию;
   * `undefined`/`false` → null — политика выключена (см. resolveYdbRetryPolicy).
   */
  resolveRetryPolicy(
    input?: YdbRetryPolicyInput,
  ): YdbResolvedRetryPolicy | null;

  /**
   * Оборачивает executor retry-политикой: одна попытка SDK на попытку
   * политики, повторяются только явно идемпотентные запросы
   * (см. withRetryPolicy).
   */
  withRetryPolicy(
    executor: YdbExecutor,
    policyInput?: YdbRetryPolicyInput,
  ): YdbExecutor;

  // --- Схема БД -------------------------------------------------------------

  /**
   * Создаёт синхронизатор схемы (DDL + DescribeTable) поверх драйвера и
   * executor'а. Используется NestJS-модулем (sync: true) и CLI.
   */
  createSchemaSyncer(driver: Driver, executor: YdbExecutor): YdbSchemaSyncer;
}
