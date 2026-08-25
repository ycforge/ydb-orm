import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { CredentialsProvider } from '@ydbjs/auth';
import { createYdbCredentialsProvider } from '@ycforge/auth/ydb';
import { YDB_AUTH_USAGE } from '@ycforge/auth';
import {
  YdbExecutor,
  YdbModuleOptions,
  YdbTransactionHandle,
  YdbTransactionOptions,
} from './interfaces.js';
import { ConsoleQueryLogger, wrapExecutorWithLogging } from './query-logger.js';
import { withRetryPolicy } from './retry-executor.js';

/**
 * Fail-fast валидация опций модуля: без endpoint драйвер упал бы позже
 * с непонятной ошибкой в недрах SDK.
 */
export function validateYdbModuleOptions(
  opts: YdbModuleOptions,
  injected?: CredentialsProvider,
): void {
  if (!opts || typeof opts.endpoint !== 'string' || !opts.endpoint.trim()) {
    throw new Error(
      'YDB module options: "endpoint" is required ' +
        '(e.g. "grpcs://ydb.serverless.yandexcloud.net:2135"). ' +
        'Return it from useFactory/useClass in YdbCoreModule.forRootAsync().',
    );
  }
  assertNoCredentialsProviderConflict(opts);
  assertAuthPresent(opts, injected);
}

function assertAuthPresent(
  opts: YdbModuleOptions,
  injected?: CredentialsProvider,
): void {
  if (
    opts.auth === undefined &&
    opts.credentialsProvider === undefined &&
    opts.driverOptions?.credentialsProvider === undefined &&
    injected === undefined
  ) {
    throw new Error(
      'YDB auth is required: pass "auth" (AuthManager) or a CredentialsProvider.',
    );
  }
}

/**
 * Конфликт источников CredentialsProvider (#96): если задан низкоуровневый
 * driverOptions.credentialsProvider вместе с верхнеуровневым источником
 * (явный credentialsProvider или auth/AuthManager), приоритет не выбирается
 * молча — это ошибка конфигурации.
 */
function assertNoCredentialsProviderConflict(opts: YdbModuleOptions): void {
  const lowLevel = opts.driverOptions?.credentialsProvider !== undefined;
  if (!lowLevel) return;
  const names: string[] = [];
  if (opts.credentialsProvider !== undefined)
    names.push('"credentialsProvider"');
  if (opts.auth !== undefined) names.push('"auth"');
  if (names.length > 0) {
    names.push('"driverOptions.credentialsProvider"');
    throw new Error(
      `Conflicting YDB credentials configuration: ${names.join(' and ')} ` +
        'are set. Keep only one source: either pass the provider via the ' +
        'top-level "credentialsProvider"/"auth" option or remove it from ' +
        '"driverOptions".',
    );
  }
}

/**
 * Разрешает итоговый CredentialsProvider по детерминированному приоритету (#96):
 *
 *   1. opts.credentialsProvider — явный провайдер из опций модуля;
 *   2. opts.auth — AuthManager из @ycforge/auth (адаптер
 *      createYdbCredentialsProvider из '@ycforge/auth/ydb');
 *   3. injected — провайдер, пришедший из DI (YDB_CREDENTIALS_PROVIDER) или
 *      переданный аргументом в createDriver();
 *   4. opts.driverOptions.credentialsProvider — низкоуровневая опция драйвера.
 *
 * Комбинация (1)/(2) + (4) запрещена — ошибка конфигурации, а не молчаливый
 * выбор. Используется NestJS-модулем, createDriver() и CLI.
 */
export function resolveCredentialsProvider(
  opts: YdbModuleOptions,
  injected?: CredentialsProvider,
): CredentialsProvider {
  assertNoCredentialsProviderConflict(opts);
  const provider =
    opts.credentialsProvider ??
    (opts.auth !== undefined
      ? createYdbCredentialsProvider(opts.auth, YDB_AUTH_USAGE, {
          endpoint: opts.endpoint,
          // grpc:// — локальный insecure-эндпоинт; grpcs:// — TLS (дефолт).
          secure: !opts.endpoint.startsWith('grpc://'),
        })
      : undefined) ??
    injected ??
    opts.driverOptions?.credentialsProvider;

  if (provider === undefined) {
    throw new Error(
      'YDB auth is required: pass "auth" (AuthManager) or a CredentialsProvider.',
    );
  }

  return provider;
}

/** Создаёт подключённый Driver по опциям модуля. */
export async function createDriver(
  opts: YdbModuleOptions,
  credentialsProvider?: CredentialsProvider,
): Promise<Driver> {
  validateYdbModuleOptions(opts, credentialsProvider);
  // Провайдер разрешается по единому правилу приоритета (#96) и передаётся
  // ПОСЛЕ spread driverOptions: driverOptions.credentialsProvider не может
  // молча перезатереть уже разрешённый провайдер.
  const resolvedProvider = resolveCredentialsProvider(
    opts,
    credentialsProvider,
  );
  const { credentialsProvider: _driverOptionsProvider, ...restDriverOptions } =
    opts.driverOptions ?? {};
  const driver = new Driver(opts.endpoint, {
    ...restDriverOptions,
    credentialsProvider: resolvedProvider,
  });
  await driver.ready();
  return driver;
}

/** Создаёт executor (query client) поверх драйвера. */
export function createExecutor(
  driver: Driver,
  opts: YdbModuleOptions,
): YdbExecutor {
  const client = query(driver, {
    poolOptions: opts.poolOptions
      ? Object.fromEntries(
          Object.entries(opts.poolOptions).filter(([, v]) => v !== undefined),
        )
      : undefined,
  });

  // Адаптация клиента @ydbjs/query к интерфейсу YdbExecutor (#98):
  // client.transaction(options, fn) — функция, возвращающая промис, а
  // интерфейс ORM ожидает transaction(options?) => { execute(fn) }.
  // Раньше адаптация существовала только в wrapExecutorWithLogging, из-за
  // чего runInTransaction на «живом» SDK падал. Опции (isolation/signal/
  // idempotent) пробрасываются в SDK как есть; timeout реализуется менеджером
  // транзакций per-attempt (свежее AbortSignal.timeout на каждую попытку)
  // и до SDK не доходит.
  const adapted = ((strings: TemplateStringsArray, ...args: any[]) =>
    client(strings, ...args)) as unknown as YdbExecutor;

  (adapted as any).transaction = (
    options?: YdbTransactionOptions,
  ): YdbTransactionHandle => ({
    execute: async <T>(
      fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const { isolation, signal, idempotent } = options ?? {};
      return client.transaction({ isolation, idempotent, signal }, (tx, sgn) =>
        fn(tx as unknown as YdbExecutor, sgn),
      );
    },
  });

  let executor = adapted;

  // Retry-политика (#27): опциональна, по умолчанию выключена (ретраит
  // только SDK). Обёртка ставится ПОД логирование, чтобы каждая попытка
  // политики попадала в лог отдельно.
  if (opts.retry !== undefined && opts.retry !== false) {
    executor = withRetryPolicy(executor, opts.retry);
  }

  if (opts.logQueries) {
    const logger =
      typeof opts.logQueries === 'object' && opts.logQueries !== null
        ? opts.logQueries
        : new ConsoleQueryLogger();
    executor = wrapExecutorWithLogging(executor, logger);
  }

  return executor;
}
