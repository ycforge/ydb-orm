import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { CredentialsProvider } from '@ydbjs/auth';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';
import { AuthKeyCredentialsProvider } from '../credentials/auth-key-credentials-provider.js';
import {
  YdbExecutor,
  YdbModuleOptions,
  YdbTransactionHandle,
  YdbTransactionOptions,
} from './interfaces.js';
import { ConsoleQueryLogger, wrapExecutorWithLogging } from './query-logger.js';
import { withRetryPolicy } from './retry-executor.js';

/**
 * Fail-fast валидация опций модуля: без endpoint/auth_options драйвер
 * упал бы позже с непонятной ошибкой в недрах SDK.
 */
export function validateYdbModuleOptions(opts: YdbModuleOptions): void {
  if (!opts || typeof opts.endpoint !== 'string' || !opts.endpoint.trim()) {
    throw new Error(
      'YDB module options: "endpoint" is required ' +
        '(e.g. "grpcs://ydb.serverless.yandexcloud.net:2135"). ' +
        'Return it from useFactory/useClass in YdbCoreModule.forRootAsync().',
    );
  }
  if (opts.auth_type === 'auth_key' && !opts.authOptions?.authorized_key_path) {
    throw new Error(
      'YDB module options: "authOptions.authorized_key_path" is required ' +
        'when auth_type is "auth_key".',
    );
  }
  assertNoCredentialsProviderConflict(opts);
}

/**
 * Конфликт источников CredentialsProvider (#96): если заданы и явный
 * credentialsProvider, и низкоуровневый driverOptions.credentialsProvider,
 * приоритет не выбирается молча — это ошибка конфигурации.
 */
function assertNoCredentialsProviderConflict(opts: YdbModuleOptions): void {
  if (
    opts.credentialsProvider !== undefined &&
    opts.driverOptions?.credentialsProvider !== undefined
  ) {
    throw new Error(
      'Conflicting YDB credentials configuration: both "credentialsProvider" ' +
        'and "driverOptions.credentialsProvider" are set. Keep only one source: ' +
        'either pass the provider via the top-level "credentialsProvider" option ' +
        'or remove it from "driverOptions".',
    );
  }
}

/**
 * Разрешает итоговый CredentialsProvider по детерминированному приоритету (#96):
 *
 *   1. opts.credentialsProvider — явный провайдер из опций модуля;
 *   2. injected — провайдер, пришедший из DI (YDB_CREDENTIALS_PROVIDER) или
 *      переданный аргументом в createDriver();
 *   3. opts.driverOptions.credentialsProvider — низкоуровневая опция драйвера;
 *   4. создание по auth_type (createCredentialsProvider).
 *
 * Комбинация (1) + (3) запрещена — ошибка конфигурации, а не молчаливый
 * выбор. Используется NestJS-модулем, createDriver() и CLI.
 */
export function resolveCredentialsProvider(
  opts: YdbModuleOptions,
  injected?: CredentialsProvider,
): CredentialsProvider {
  assertNoCredentialsProviderConflict(opts);
  return (
    opts.credentialsProvider ??
    injected ??
    opts.driverOptions?.credentialsProvider ??
    createCredentialsProvider(opts)
  );
}

/**
 * Создаёт credentials provider по `auth_type` из опций модуля.
 * Используется и NestJS-модулем, и CLI миграций.
 */
export function createCredentialsProvider(
  opts: YdbModuleOptions,
): CredentialsProvider {
  switch (opts.auth_type) {
    case 'meta':
      return new MetadataCredentialsProvider();
    case 'auth_key':
      if (!opts.authOptions?.authorized_key_path) {
        throw new Error(
          '"authOptions.authorized_key_path" is required ' +
            'when auth_type is "auth_key".',
        );
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
}

/** Создаёт подключённый Driver по опциям модуля. */
export async function createDriver(
  opts: YdbModuleOptions,
  credentialsProvider?: CredentialsProvider,
): Promise<Driver> {
  validateYdbModuleOptions(opts);
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
