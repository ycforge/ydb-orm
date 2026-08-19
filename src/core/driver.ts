import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { CredentialsProvider } from '@ydbjs/auth';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';
import { AuthKeyCredentialsProvider } from '../credentials/auth-key-credentials-provider.js';
import { YdbExecutor, YdbModuleOptions } from './interfaces.js';
import { ConsoleQueryLogger, wrapExecutorWithLogging } from './query-logger.js';

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
  const driver = new Driver(opts.endpoint, {
    credentialsProvider: credentialsProvider ?? createCredentialsProvider(opts),
    ...opts.driverOptions,
  });
  await driver.ready();
  return driver;
}

/** Создаёт executor (query client) поверх драйвера. */
export function createExecutor(
  driver: Driver,
  opts: YdbModuleOptions,
): YdbExecutor {
  let executor = query(driver, {
    poolOptions: opts.poolOptions
      ? Object.fromEntries(
          Object.entries(opts.poolOptions).filter(([, v]) => v !== undefined),
        )
      : undefined,
  }) as unknown as YdbExecutor;

  if (opts.logQueries) {
    const logger =
      typeof opts.logQueries === 'object' && opts.logQueries !== null
        ? opts.logQueries
        : new ConsoleQueryLogger();
    executor = wrapExecutorWithLogging(executor, logger);
  }

  return executor;
}
