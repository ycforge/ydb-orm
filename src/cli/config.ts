import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Driver } from '@ydbjs/core';
import { YdbExecutor, YdbModuleOptions } from '../core/interfaces.js';
import { createDriver, createExecutor } from '../core/driver.js';

/** Конфиг CLI: опции подключения + пути для миграций. */
export interface YdbCliConfig extends YdbModuleOptions {
  /** Директория с миграциями (по умолчанию ./migrations). */
  migrationsDir?: string;
  /** Сущности для migration:generate. */
  entities?: (new (...args: any[]) => any)[];
}

const DEFAULT_CONFIG_NAMES = [
  'ydb-orm.config.ts',
  'ydb-orm.config.mts',
  'ydb-orm.config.mjs',
  'ydb-orm.config.js',
];

/**
 * Загружает конфиг CLI:
 *  1. --config <path> или ./ydb-orm.config.{ts,mts,mjs,js};
 *  2. иначе — переменные окружения YDB_ENDPOINT / YDB_CONNECTION_STRING,
 *     YDB_AUTH_TYPE (по умолчанию anonymous), YDB_AUTHORIZED_KEY_PATH.
 */
export async function loadCliConfig(
  configPath?: string,
): Promise<YdbCliConfig> {
  const file = configPath ?? findDefaultConfig();
  if (file) {
    const mod = (await import(
      pathToFileURL(path.resolve(file)).href
    )) as Record<string, any>;
    const config = (mod.default ?? mod) as YdbCliConfig;
    if (!config.endpoint) {
      throw new Error(`Config ${file}: "endpoint" is required`);
    }
    return config;
  }

  const endpoint =
    process.env.YDB_ENDPOINT ?? process.env.YDB_CONNECTION_STRING;
  if (!endpoint) {
    throw new Error(
      'No CLI config found. Create ydb-orm.config.ts or set YDB_ENDPOINT.',
    );
  }

  return {
    endpoint,
    auth_type:
      (process.env.YDB_AUTH_TYPE as YdbModuleOptions['auth_type']) ??
      'anonymous',
    authOptions: {
      authorized_key_path: process.env.YDB_AUTHORIZED_KEY_PATH,
    },
  };
}

function findDefaultConfig(): string | undefined {
  return DEFAULT_CONFIG_NAMES.map((name) => path.resolve(name)).find((p) =>
    fs.existsSync(p),
  );
}

/** Подключение для команд CLI: driver + executor, закрывается через close(). */
export async function connectCli(config: YdbCliConfig): Promise<{
  driver: Driver;
  executor: YdbExecutor;
  close: () => void;
}> {
  const driver = await createDriver(config);
  const executor = createExecutor(driver, config);
  return { driver, executor, close: () => driver.close() };
}
