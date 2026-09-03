import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Driver } from '@ydbjs/core';
import { YdbExecutor, YdbModuleOptions } from '../core/interfaces.js';
import { createDriver, createExecutor } from '../core/driver.js';

/** CLI config: connection options + migration paths. */
export interface YdbCliConfig extends YdbModuleOptions {
  /** Directory with migrations (defaults to ./migrations). */
  migrationsDir?: string;
  /** Entities for migration:generate. */
  entities?: (new (...args: any[]) => any)[];
}

/**
 * Checks that the config declares an authentication method.
 * The CLI never builds an AuthManager itself: the user must pass a ready-made
 * `auth` (createAuth(...)) or a CredentialsProvider.
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
 * Whether a module export looks like a CLI config (#103).
 * Needed to support named config exports: only the default export used to be
 * understood, so a file like `export const config = { endpoint: ... }` raised
 * a misleading "endpoint is required" error.
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
 * Extracts the config from an imported configuration module.
 * Supports both a default export and named exports; when several different
 * matching exports exist, `default` wins, otherwise it is an ambiguity
 * (an error listing the candidates) rather than a silent pick of the first
 * one (#103). A missing endpoint is an error naming the file and the export.
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

  // De-dup by value: a default and a named export of the same object form
  // a single candidate.
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
 * Looks for the default config in startDir and up the directory tree to the
 * filesystem root (#103). Previously the search covered only the CWD, so
 * running from a nested monorepo directory missed the config at the project
 * root. Within one directory the priority is: .ts → .mts → .mjs → .js.
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
 * Loads the CLI config:
 *  1. --config <path> or ydb-orm.config.{ts,mts,mjs|js} found in the CWD
 *     or above; default and named exports are equivalent;
 *  2. otherwise — the YDB_ENDPOINT / YDB_CONNECTION_STRING environment
 *     variables (still requires ydb-orm.config.ts to specify auth).
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

/** Connection for CLI commands: driver + executor, closed via close(). */
export async function connectCli(config: YdbCliConfig): Promise<{
  driver: Driver;
  executor: YdbExecutor;
  close: () => void;
}> {
  const driver = await createDriver(config);
  const executor = createExecutor(driver, config);
  return { driver, executor, close: () => driver.close() };
}
