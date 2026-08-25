import 'reflect-metadata';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { CredentialsProvider } from '@ydbjs/auth';
import { createAuth, authKeyFromFile, YDB_AUTH_USAGE } from '@ycforge/auth';
import { createYdbCredentialsProvider } from '@ycforge/auth/ydb';
import type { YdbExecutor } from '../../src/core/interfaces.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import type {
  YdbEncryptionProvider,
  YdbBlindIndexProvider,
} from '../../src/encryption/ydb-encryption-provider.interface.js';

export interface E2eContext {
  driver: Driver;
  executor: YdbExecutor;
  encryptionProvider: YdbEncryptionProvider;
  blindIndexProvider: YdbBlindIndexProvider;
  dbPath: string;
}

function getEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function requireEnv(name: string): string {
  const val = getEnv(name);
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

/**
 * Создаёт credentials provider по auth_type из переменных окружения.
 */
function createCredentialsProvider(authType: string): CredentialsProvider {
  const endpoint = getEnv('YDB_ENDPOINT')!;

  switch (authType) {
    case 'meta':
      return createYdbCredentialsProvider(
        createAuth({ type: 'metadata' }),
        YDB_AUTH_USAGE,
        {
          endpoint,
        },
      );
    case 'auth_key': {
      const keyPath = requireEnv('YDB_AUTHORIZED_KEY_PATH');
      const key = authKeyFromFile(keyPath);
      return createYdbCredentialsProvider(
        createAuth({
          type: 'auth_key',
          keyId: key.keyId,
          serviceAccountId: key.serviceAccountId,
          privateKey: key.privateKey,
        }),
        YDB_AUTH_USAGE,
        { endpoint },
      );
    }
    case 'anonymous':
      return createYdbCredentialsProvider(
        createAuth({ type: 'anonymous' }),
        YDB_AUTH_USAGE,
        {
          endpoint,
        },
      );
    default:
      throw new Error(`Invalid auth_type: ${authType}`);
  }
}

/**
 * Создаёт подключение к YDB и executor.
 * Возвращает null если переменные окружения не заданы (skip tests).
 */
export async function createE2eContext(): Promise<E2eContext | null> {
  const endpoint = getEnv('YDB_ENDPOINT');
  const authType = getEnv('YDB_AUTH_TYPE');

  if (!endpoint || !authType) {
    return null;
  }

  const credentialsProvider = createCredentialsProvider(authType);
  const driver = new Driver(endpoint, { credentialsProvider });
  await driver.ready();

  const executor = query(driver) as unknown as YdbExecutor;
  const encryptionProvider = new TestOnlyEncryptionProvider();

  // Извлекаем путь БД из endpoint (параметр database)
  const url = new URL(endpoint);
  const dbPath = url.searchParams.get('database') ?? '/local';

  return {
    driver,
    executor,
    encryptionProvider,
    blindIndexProvider: encryptionProvider,
    dbPath,
  };
}

/**
 * Закрывает подключение к YDB.
 */
export function closeE2eContext(ctx: E2eContext): void {
  ctx.driver.close();
}

/**
 * Skip helper: если YDB_ENDPOINT не задан, пропускает тест.
 */
export function hasYdbCredentials(): boolean {
  return !!(getEnv('YDB_ENDPOINT') && getEnv('YDB_AUTH_TYPE'));
}

/**
 * Создаёт таблицу для сущности через schema-sync (генерирует корректные YQL-типы).
 * Если таблица уже существует — игнорирует ошибку.
 */
export async function createTableForEntity(
  executor: YdbExecutor,
  entityClass: new (...args: any[]) => any,
): Promise<void> {
  const { buildExpectedTableSchema, generateCreateTableYql } =
    await import('../../src/schema/schema-sync.js');
  const { getYdbEntityMetadata } =
    await import('../../src/metadata/entity-metadata.js');

  const meta = getYdbEntityMetadata(entityClass);
  if (!meta)
    throw new Error(`${entityClass.name} is not decorated with @YdbEntity`);
  const expected = buildExpectedTableSchema(meta);
  const yql = generateCreateTableYql(expected);
  const tmpl = [yql] as unknown as TemplateStringsArray;
  tmpl.raw = [yql];
  try {
    await executor(tmpl);
  } catch {
    // Table already exists
  }
}

/**
 * Удаляет таблицу для сущности.
 */
export async function dropTableForEntity(
  executor: YdbExecutor,
  entityClass: new (...args: any[]) => any,
): Promise<void> {
  const { getYdbEntityMetadata } =
    await import('../../src/metadata/entity-metadata.js');
  const meta = getYdbEntityMetadata(entityClass);
  if (!meta) return;
  const tmpl = [
    `DROP TABLE IF EXISTS \`${meta.tableName}\``,
  ] as unknown as TemplateStringsArray;
  tmpl.raw = tmpl;
  try {
    await executor(tmpl);
  } catch {
    // Ignore
  }
}
