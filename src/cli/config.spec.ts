import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, afterEach, beforeEach, expect, it } from '@jest/globals';
import {
  extractCliConfig,
  findDefaultConfig,
  loadCliConfig,
} from './config.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-orm-config-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('extractCliConfig (#103)', () => {
  const endpoint = 'grpc://localhost:2136/local';

  it('accepts a default export object', () => {
    const config = { endpoint };
    expect(extractCliConfig({ default: config }, 'cfg.ts')).toBe(config);
  });

  it('accepts a named export instead of the default one', () => {
    // Раньше понимался только default export: файл с named экспортом
    // давал ложную ошибку «endpoint is required».
    const config = { endpoint };
    expect(extractCliConfig({ config }, 'cfg.ts')).toBe(config);
    expect(extractCliConfig({ cliConfig: config }, 'cfg.ts')).toBe(config);
  });

  it('prefers default over named exports when they differ', () => {
    const config = { endpoint };
    const named = { endpoint: 'grpc://other:2136/local' };

    expect(extractCliConfig({ config: named, default: config }, 'cfg.ts')).toBe(
      config,
    );
  });

  it('treats default and named exports of the same object as one candidate', () => {
    const config = {
      endpoint,
      migrationsDir: './migrations',
      entities: [],
    };
    const mod = { config, default: config };

    expect(extractCliConfig(mod, 'cfg.ts')).toBe(config);
  });

  it('reports an ambiguity between several named exports', () => {
    const mod = {
      a: { endpoint },
      b: { endpoint },
    };

    expect(() => extractCliConfig(mod, 'cfg.ts')).toThrow(
      /multiple exports look like a CLI config \(a, b\)/,
    );
  });

  it('lists actual exports when nothing looks like a config', () => {
    expect(() => extractCliConfig({ helper: 42 }, 'cfg.ts')).toThrow(
      /expected a default or named export with an "endpoint" \(found exports: helper\)/,
    );
    expect(() => extractCliConfig({}, 'cfg.ts')).toThrow(
      /\(found exports: none\)/,
    );
  });

  it('names the offending export when endpoint is missing', () => {
    expect(() =>
      extractCliConfig({ config: { migrationsDir: './m' } }, 'cfg.ts'),
    ).toThrow(/"endpoint" is required/);
    expect(() =>
      extractCliConfig({ config: { migrationsDir: './m' } }, 'cfg.ts'),
    ).toThrow(/\("config"\)/);
  });
});

describe('findDefaultConfig (#103)', () => {
  it('searches upwards through parent directories', () => {
    const nested = path.join(dir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ydb-orm.config.mjs'), '', 'utf-8');

    expect(findDefaultConfig(nested)).toBe(
      path.join(dir, 'ydb-orm.config.mjs'),
    );
  });

  it('respects extension priority inside one directory', () => {
    fs.writeFileSync(path.join(dir, 'ydb-orm.config.js'), '', 'utf-8');
    fs.writeFileSync(path.join(dir, 'ydb-orm.config.mts'), '', 'utf-8');

    expect(findDefaultConfig(dir)).toBe(path.join(dir, 'ydb-orm.config.mts'));
  });

  it('prefers yorm.config.* over legacy ydb-orm.config.*', () => {
    fs.writeFileSync(path.join(dir, 'ydb-orm.config.ts'), '', 'utf-8');
    fs.writeFileSync(path.join(dir, 'yorm.config.js'), '', 'utf-8');

    expect(findDefaultConfig(dir)).toBe(path.join(dir, 'yorm.config.js'));
  });

  it('returns undefined when nothing found up to the filesystem root', () => {
    expect(findDefaultConfig(dir)).toBeUndefined();
  });
});

describe('loadCliConfig (#103)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads a named-export .mjs config found above the start directory', async () => {
    fs.writeFileSync(
      path.join(dir, 'ydb-orm.config.mjs'),
      `export const config = {
        endpoint: 'grpc://named:2136/local',
        credentialsProvider: { getToken: async () => 'token' },
        migrationsDir: './migrations',
      };`,
      'utf-8',
    );
    const nested = path.join(dir, 'nested');
    fs.mkdirSync(nested);

    const config = await loadCliConfig(undefined, nested);

    expect(config.endpoint).toBe('grpc://named:2136/local');
    expect(config.migrationsDir).toBe('./migrations');
  });

  it('fails clearly when --config points to a missing file', async () => {
    await expect(loadCliConfig('./no-such.config.ts', dir)).rejects.toThrow(
      new RegExp(`Config file not found: .*no-such\\.config\\.ts`),
    );
  });

  it('falls back to env endpoint when no config exists', async () => {
    delete process.env.YDB_ENDPOINT;
    delete process.env.YDB_CONNECTION_STRING;
    process.env.YDB_ENDPOINT = 'grpc://env:2136/local';

    await expect(loadCliConfig(undefined, dir)).rejects.toThrow(
      /YDB auth is required/,
    );
  });

  it('requires auth in the config file', async () => {
    fs.writeFileSync(
      path.join(dir, 'ydb-orm.config.mts'),
      `export default {
        endpoint: 'grpc://cfg:2136/local',
      };`,
      'utf-8',
    );

    await expect(loadCliConfig(undefined, dir)).rejects.toThrow(
      /YDB auth is required/,
    );
  });

  it('accepts a config file with an explicit CredentialsProvider', async () => {
    fs.writeFileSync(
      path.join(dir, 'ydb-orm.config.mts'),
      `export default {\n` +
        `  endpoint: 'grpc://cfg:2136/local',\n` +
        `  credentialsProvider: { getToken: async () => 'token' },\n` +
        `};`,
      'utf-8',
    );

    const config = await loadCliConfig(undefined, dir);

    expect(config.endpoint).toBe('grpc://cfg:2136/local');
    expect(config.credentialsProvider).toBeDefined();
  });
});
