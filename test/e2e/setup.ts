import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * Writes a CLI config for tests that invoke the built `ydb-orm` binary.
 * Environment variables alone are not enough for the CLI: it requires an
 * explicit auth source, so an anonymous inline provider is used for local YDB.
 */
export function writeCliConfig(dir: string, endpoint: string): void {
  // The config is imported by Node directly, so bare specifiers must resolve
  // from the temporary directory. A node_modules symlink keeps the temp dir
  // isolated while allowing the config to construct a real provider class.
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const nodeModules = path.join(dir, 'node_modules');
  fs.mkdirSync(path.join(nodeModules, '@ycforge'), { recursive: true });
  const linkedPackage = path.join(nodeModules, '@ycforge', 'ydb-orm');
  if (!fs.existsSync(linkedPackage)) {
    fs.symlinkSync(repoRoot, linkedPackage, 'dir');
  }
  const linkedYdbjs = path.join(nodeModules, '@ydbjs');
  if (!fs.existsSync(linkedYdbjs)) {
    fs.symlinkSync(
      path.join(repoRoot, 'node_modules', '@ydbjs'),
      linkedYdbjs,
      'dir',
    );
  }
  fs.writeFileSync(
    path.join(dir, 'ydb-orm.config.mjs'),
    `import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';

export default {
  endpoint: ${JSON.stringify(endpoint)},
  credentialsProvider: new AnonymousCredentialsProvider(),
  // Single-node local YDB: go straight to the endpoint.
  driverOptions: { 'ydb.sdk.enable_discovery': false },
};
`,
    'utf-8',
  );
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
  // A single-node local YDB can be addressed by a scheme subdirectory instead
  // of a real tenant database; discovery rejects such paths, so it can be
  // disabled explicitly for local runs.
  const driver = new Driver(endpoint, {
    credentialsProvider,
    ...(getEnv('YDB_DISABLE_DISCOVERY') === '1'
      ? { 'ydb.sdk.enable_discovery': false }
      : {}),
  });
  await driver.ready();

  const executor = query(driver) as unknown as YdbExecutor;
  const encryptionProvider = new TestOnlyEncryptionProvider();

  // Extract the database path from the endpoint: either an explicit
  // ?database= parameter or the pathname (grpc://host:2136/local).
  const url = new URL(endpoint);
  const dbPath =
    url.searchParams.get('database') ??
    (url.pathname !== '/' ? url.pathname : '/local');

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
  try {
    await executor(tmpl);
  } catch {
    // Ignore
  }
}
