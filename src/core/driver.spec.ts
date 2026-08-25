import 'reflect-metadata';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { CredentialsProvider } from '@ydbjs/auth';
import { createAuth } from '@ycforge/auth';
import type { YdbModuleOptions } from './interfaces.js';

/**
 * Спеки ядра подключения (#96): приоритет источников CredentialsProvider,
 * конфликт конфигурации и поведение с AuthManager.
 *
 * Модуль @ydbjs/core подменяется заглушкой ДО первого импорта ./driver.js
 * (динамический импорт после jest.unstable_mockModule), чтобы createDriver
 * можно было вызвать без сети и проверить, какой провайдер дошёл до
 * конструктора Driver.
 */

/** Заглушка провайдера с маркером: по значению видно, кто разрешён. */
function makeProvider(tag: string): CredentialsProvider {
  return {
    getToken: () => Promise.resolve(`token:${tag}`),
  } as unknown as CredentialsProvider;
}

const BASE_OPTIONS: YdbModuleOptions = {
  endpoint: 'grpc://localhost:2136/local',
  auth: createAuth({ type: 'anonymous' }),
};

class StubDriver {
  static calls: Array<{ endpoint: string; options: Record<string, any> }> = [];
  constructor(cs: string, options: Record<string, any>) {
    StubDriver.calls.push({ endpoint: cs, options });
  }
  async ready(): Promise<void> {}

  close(): any {}
}

type DriverModule = typeof import('./driver.js');
let mod: DriverModule;

beforeAll(async () => {
  StubDriver.calls = [];
  jest.unstable_mockModule('@ydbjs/core', () => ({ Driver: StubDriver }));
  mod = await import('./driver.js');
});

describe('resolveCredentialsProvider (#96)', () => {
  it('явный opts.credentialsProvider используется как есть', () => {
    const custom = makeProvider('custom');
    const resolved = mod.resolveCredentialsProvider({
      ...BASE_OPTIONS,
      credentialsProvider: custom,
    });

    expect(resolved).toBe(custom);
  });

  it('opts.auth адаптируется в CredentialsProvider', () => {
    const resolved = mod.resolveCredentialsProvider({
      endpoint: 'grpc://localhost:2136/local',
      auth: createAuth({ type: 'anonymous' }),
    });

    expect(resolved.constructor.name).toBe('AnonymousCredentialsProvider');
  });

  it('opts.auth: getToken делегирует AuthManager (usage ydb)', async () => {
    const resolved = mod.resolveCredentialsProvider({
      endpoint: 'grpc://localhost:2136/local',
      auth: createAuth({ type: 'access_token', token: 'tok-auth' }),
    });

    await expect(resolved.getToken()).resolves.toBe('tok-auth');
  });

  it('injected (DI) используется при отсутствии явного провайдера и auth', () => {
    const injected = makeProvider('injected');
    const resolved = mod.resolveCredentialsProvider(
      { endpoint: 'grpc://localhost:2136/local' },
      injected,
    );

    expect(resolved).toBe(injected);
  });

  it('driverOptions.credentialsProvider используется без явных источников', () => {
    const lowLevel = makeProvider('low-level');
    const resolved = mod.resolveCredentialsProvider({
      endpoint: 'grpc://localhost:2136/local',
      driverOptions: { credentialsProvider: lowLevel },
    });

    expect(resolved).toBe(lowLevel);
  });

  it('конфликт credentialsProvider и driverOptions.credentialsProvider — ошибка', () => {
    const custom = makeProvider('custom');
    const lowLevel = makeProvider('low-level');

    expect(() =>
      mod.resolveCredentialsProvider({
        endpoint: 'grpc://localhost:2136/local',
        credentialsProvider: custom,
        driverOptions: { credentialsProvider: lowLevel },
      }),
    ).toThrow(
      /Conflicting YDB credentials configuration[\s\S]*"credentialsProvider"[\s\S]*"driverOptions.credentialsProvider"/,
    );
  });

  it('конфликт auth и driverOptions.credentialsProvider — ошибка', () => {
    expect(() =>
      mod.resolveCredentialsProvider({
        endpoint: 'grpc://localhost:2136/local',
        auth: createAuth({ type: 'anonymous' }),
        driverOptions: { credentialsProvider: makeProvider('low-level') },
      }),
    ).toThrow(
      /Conflicting YDB credentials configuration[\s\S]*"auth"[\s\S]*"driverOptions.credentialsProvider"/,
    );
  });

  it('отсутствие auth и CredentialsProvider — понятная ошибка', () => {
    expect(() =>
      mod.resolveCredentialsProvider({
        endpoint: 'grpc://localhost:2136/local',
      }),
    ).toThrow(/YDB auth is required/);
  });
});

describe('resolveCredentialsProvider: приоритеты', () => {
  it('явный opts.credentialsProvider приоритетнее opts.auth', () => {
    const custom = makeProvider('custom');
    const resolved = mod.resolveCredentialsProvider({
      endpoint: 'grpc://localhost:2136/local',
      credentialsProvider: custom,
      auth: createAuth({ type: 'anonymous' }),
    });

    expect(resolved).toBe(custom);
  });

  it('opts.auth приоритетнее injected (DI) провайдера', () => {
    const injected = makeProvider('injected');
    const resolved = mod.resolveCredentialsProvider(
      {
        endpoint: 'grpc://localhost:2136/local',
        auth: createAuth({ type: 'access_token', token: 'tok-auth' }),
      },
      injected,
    );

    expect(resolved).not.toBe(injected);
  });

  it('injected приоритетнее driverOptions.credentialsProvider', () => {
    const injected = makeProvider('injected');
    const lowLevel = makeProvider('low-level');
    const resolved = mod.resolveCredentialsProvider(
      {
        endpoint: 'grpc://localhost:2136/local',
        driverOptions: { credentialsProvider: lowLevel },
      },
      injected,
    );

    expect(resolved).toBe(injected);
  });
});

describe('validateYdbModuleOptions (#96)', () => {
  it('fail-fast на конфликт источников провайдера ещё до создания драйвера', () => {
    expect(() =>
      mod.validateYdbModuleOptions({
        endpoint: 'grpc://localhost:2136/local',
        credentialsProvider: makeProvider('custom'),
        driverOptions: { credentialsProvider: makeProvider('low-level') },
      }),
    ).toThrow(/Conflicting YDB credentials configuration/);
  });

  it('fail-fast на конфликт auth + driverOptions', () => {
    expect(() =>
      mod.validateYdbModuleOptions({
        endpoint: 'grpc://localhost:2136/local',
        auth: createAuth({ type: 'anonymous' }),
        driverOptions: { credentialsProvider: makeProvider('low-level') },
      }),
    ).toThrow(/Conflicting YDB credentials configuration/);
  });
});

describe('createDriver (#96): провайдер доходит до Driver', () => {
  it('явный opts.credentialsProvider передаётся в конструктор драйвера', async () => {
    const custom = makeProvider('custom');

    await mod.createDriver({
      ...BASE_OPTIONS,
      credentialsProvider: custom,
    });

    const call = StubDriver.calls.at(-1)!;
    expect(call.options.credentialsProvider).toBe(custom);
  });

  it('аргумент createDriver() (путь NestJS DI) доходит до драйвера', async () => {
    const injected = makeProvider('injected');

    await mod.createDriver(
      { endpoint: 'grpc://localhost:2136/local' },
      injected,
    );

    const call = StubDriver.calls.at(-1)!;
    expect(call.options.credentialsProvider).toBe(injected);
  });

  it('без кастомных источников используется auth (AuthManager)', async () => {
    await mod.createDriver(BASE_OPTIONS);

    const call = StubDriver.calls.at(-1)!;
    expect(call.options.credentialsProvider.constructor.name).toBe(
      'AnonymousCredentialsProvider',
    );
  });

  it('конфликт ловится fail-fast: молчаливой подмены явного провайдера нет', async () => {
    const custom = makeProvider('custom');

    await expect(
      mod.createDriver({
        ...BASE_OPTIONS,
        credentialsProvider: custom,
        driverOptions: { credentialsProvider: makeProvider('low-level') },
      }),
    ).rejects.toThrow(/Conflicting YDB credentials configuration/);
  });

  it('отсутствие auth и CredentialsProvider — понятная ошибка', async () => {
    await expect(
      mod.createDriver({ endpoint: 'grpc://localhost:2136/local' }),
    ).rejects.toThrow(/YDB auth is required/);
  });

  it('остальные driverOptions сохраняются вместе с разрешённым провайдером', async () => {
    const custom = makeProvider('custom');

    await mod.createDriver({
      ...BASE_OPTIONS,
      credentialsProvider: custom,
      driverOptions: { 'ydb.sdk.ready_timeout_ms': 1234 },
    });

    const options = StubDriver.calls.at(-1)!.options;
    expect(options['ydb.sdk.ready_timeout_ms']).toBe(1234);
    expect(options.credentialsProvider).toBe(custom);
  });
});
