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

/**
 * Проверяет, что в конфиге задан способ аутентификации.
 * CLI не создаёт AuthManager самостоятельно: пользователь должен передать
 * готовый `auth` (createAuth(...)) или CredentialsProvider.
 */
function assertCliAuth(config: YdbCliConfig): void {
  if (
    config.auth === undefined &&
    config.credentialsProvider === undefined &&
    config.driverOptions?.credentialsProvider === undefined
  ) {
    throw new Error(
      'YDB auth is required: pass "auth" (AuthManager) or a CredentialsProvider ' +
        'in ydb-orm.config.ts.',
    );
  }
}

const DEFAULT_CONFIG_NAMES = [
  'ydb-orm.config.ts',
  'ydb-orm.config.mts',
  'ydb-orm.config.mjs',
  'ydb-orm.config.js',
];

/**
 * Похож ли экспорт модуля на CLI-конфиг (#103).
 * Нужен, чтобы поддержать именованные экспорты конфига:
 * раньше понимался только default, и файл вида
 * `export const config = { endpoint: ... }` давал ложную ошибку
 * «endpoint is required».
 */
function looksLikeConfig(value: unknown): value is YdbCliConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, any>;
  return (
    typeof obj.endpoint === 'string' ||
    Array.isArray(obj.entities) ||
    typeof obj.migrationsDir === 'string'
  );
}

/**
 * Достаёт конфиг из импортированного модуля конфигурации.
 * Поддерживает default export и именованные экспорты; при нескольких
 * разных подходящих экспортах приоритет у `default`, иначе — неоднозначность
 * (ошибка со списком кандидатов), а не молчаливый выбор первого (#103).
 * Отсутствие endpoint — ошибка с указанием файла и имени экспорта.
 */
export function extractCliConfig(
  mod: Record<string, unknown>,
  file: string,
): YdbCliConfig {
  const candidates = Object.entries(mod).filter(([, value]) =>
    looksLikeConfig(value),
  ) as [string, YdbCliConfig][];

  if (candidates.length === 0) {
    throw new Error(
      `Config ${file}: expected a default or named export with an "endpoint" ` +
        `(found exports: ${Object.keys(mod).join(', ') || 'none'}).`,
    );
  }

  // Дедупликация по значению: default и именованный экспорт одного
  // и того же объекта — один кандидат.
  const byValue = new Map<YdbCliConfig, string[]>();
  for (const [name, value] of candidates) {
    const names = byValue.get(value) ?? [];
    names.push(name);
    byValue.set(value, names);
  }

  const defaultCandidate = candidates.find(([name]) => name === 'default');
  if (byValue.size > 1 && !defaultCandidate) {
    const allNames = [...byValue.values()].flat().sort().join(', ');
    throw new Error(
      `Config ${file}: multiple exports look like a CLI config ` +
        `(${allNames}). Keep exactly one or use the default export.`,
    );
  }
  const [exportName, config] =
    byValue.size > 1 ? defaultCandidate! : candidates[0];

  if (!config.endpoint) {
    throw new Error(
      `Config ${file} ("${exportName}"): "endpoint" is required.`,
    );
  }
  return config;
}

/**
 * Ищет дефолтный конфиг в startDir и вверх по дереву каталогов до корня ФС
 * (#103). Раньше поиск шёл только в CWD — запуск из вложенной директории
 * монорепо не находил конфиг в корне проекта. В одной директории приоритет:
 * .ts → .mts → .mjs → .js.
 */
export function findDefaultConfig(startDir?: string): string | undefined {
  let current = path.resolve(startDir ?? process.cwd());
  for (;;) {
    for (const name of DEFAULT_CONFIG_NAMES) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Загружает конфиг CLI:
 *  1. --config <path> или ydb-orm.config.{ts,mts,mjs|js}, найденный в CWD
 *     или выше; default и именованные экспорты эквивалентны;
 *  2. иначе — переменная окружения YDB_ENDPOINT / YDB_CONNECTION_STRING
 *     (требуется ydb-orm.config.ts для задания auth).
 */
export async function loadCliConfig(
  configPath?: string,
  startDir?: string,
): Promise<YdbCliConfig> {
  const file = configPath
    ? path.resolve(configPath)
    : findDefaultConfig(startDir);
  if (file) {
    if (!fs.existsSync(file)) {
      throw new Error(`Config file not found: ${path.resolve(file)}`);
    }
    const mod = (await import(
      pathToFileURL(path.resolve(file)).href
    )) as Record<string, unknown>;
    const config = extractCliConfig(mod, file);
    assertCliAuth(config);
    return config;
  }

  const endpoint =
    process.env.YDB_ENDPOINT ?? process.env.YDB_CONNECTION_STRING;
  if (!endpoint) {
    throw new Error(
      'No CLI config found. Create ydb-orm.config.ts or set YDB_ENDPOINT.',
    );
  }

  throw new Error(
    'YDB auth is required: create ydb-orm.config.ts with "auth" (AuthManager) ' +
      'or a CredentialsProvider.',
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
