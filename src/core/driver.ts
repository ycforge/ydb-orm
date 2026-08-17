import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { CredentialsProvider } from '@ydbjs/auth';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';
import { AuthKeyCredentialsProvider } from '../credentials/auth-key-credentials-provider.js';
import { YdbExecutor, YdbModuleOptions } from './interfaces.js';

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
}

/** Создаёт подключённый Driver по опциям модуля. */
export async function createDriver(
  opts: YdbModuleOptions,
  credentialsProvider?: CredentialsProvider,
): Promise<Driver> {
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
  return query(driver, {
    poolOptions: opts.poolOptions
      ? Object.fromEntries(
          Object.entries(opts.poolOptions).filter(([, v]) => v !== undefined),
        )
      : undefined,
  }) as unknown as YdbExecutor;
}
