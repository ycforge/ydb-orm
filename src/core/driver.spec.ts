import 'reflect-metadata';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { CredentialsProvider } from '@ydbjs/auth';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { createAuth } from '@ycforge/auth';
import type { YdbModuleOptions } from './interfaces.js';

/**
 * Спеки ядра подключения (#96): приоритет источников CredentialsProvider,
 * конфликт конфигурации и неизменное поведение по умолчанию.
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
  auth_type: 'anonymous',
  authOptions: {},
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

  it('injected (DI) используется при отсутствии явного провайдера', () => {
    const injected = makeProvider('injected');
    const resolved = mod.resolveCredentialsProvider(BASE_OPTIONS, injected);

    expect(resolved).toBe(injected);
  });

  it('driverOptions.credentialsProvider используется без явных источников', () => {
    const lowLevel = makeProvider('low-level');
    const resolved = mod.resolveCredentialsProvider({
      ...BASE_OPTIONS,
      driverOptions: { credentialsProvider: lowLevel },
    });

    expect(resolved).toBe(lowLevel);
  });

  it('конфликт credentialsProvider и driverOptions.credentialsProvider — ошибка', () => {
    const custom = makeProvider('custom');
    const lowLevel = makeProvider('low-level');

    expect(() =>
      mod.resolveCredentialsProvider({
        ...BASE_OPTIONS,
        credentialsProvider: custom,
        driverOptions: { credentialsProvider: lowLevel },
      }),
    ).toThrow(
      /Conflicting YDB credentials configuration[\s\S]*"credentialsProvider"[\s\S]*"driverOptions.credentialsProvider"/,
    );
  });

  it('поведение по умолчанию не изменилось: meta → MetadataCredentialsProvider', () => {
    const resolved = mod.resolveCredentialsProvider({
      ...BASE_OPTIONS,
      auth_type: 'meta',
    });
    expect(resolved).toBeInstanceOf(MetadataCredentialsProvider);
  });

  it('поведение по умолчанию не изменилось: anonymous → AnonymousCredentialsProvider', () => {
    const resolved = mod.resolveCredentialsProvider(BASE_OPTIONS);
    expect(resolved).toBeInstanceOf(AnonymousCredentialsProvider);
  });

  it('поведение по умолчанию не изменилось: невалидный auth_type — понятная ошибка', () => {
    expect(() =>
      mod.resolveCredentialsProvider({
        ...BASE_OPTIONS,
        auth_type: 'oauth' as never,
      }),
    ).toThrow(/Invalid YDB auth type/);
  });

  it('поведение по умолчанию не изменилось: auth_key требует authorized_key_path', () => {
    expect(() =>
      mod.resolveCredentialsProvider({
        ...BASE_OPTIONS,
        auth_type: 'auth_key',
        authOptions: {},
      }),
    ).toThrow(/authorized_key_path.*is required/);
  });
});

describe('resolveCredentialsProvider: opts.auth (@ycforge/auth)', () => {
  it('opts.auth адаптируется в CredentialsProvider: anonymous → AnonymousCredentialsProvider', () => {
    const resolved = mod.resolveCredentialsProvider({
      ...BASE_OPTIONS,
      auth: createAuth({ type: 'anonymous' }),
    });

    // instanceof по классу из @ydbjs/auth не используем: у file:-зависимости
    // @ycforge/auth своя копия пакета, поэтому сверяем имя конструктора.
    expect(resolved.constructor.name).toBe('AnonymousCredentialsProvider');
  });

  it('opts.auth: getToken делегирует AuthManager (usage ydb)', async () => {
    const resolved = mod.resolveCredentialsProvider({
      ...BASE_OPTIONS,
      auth: createAuth({ type: 'access_token', token: 'tok-auth' }),
    });

    await expect(resolved.getToken()).resolves.toBe('tok-auth');
  });

  it('явный opts.credentialsProvider приоритетнее opts.auth', () => {
    const custom = makeProvider('custom');
    const resolved = mod.resolveCredentialsProvider({
      ...BASE_OPTIONS,
      credentialsProvider: custom,
      auth: createAuth({ type: 'anonymous' }),
    });

    expect(resolved).toBe(custom);
  });

  it('opts.auth приоритетнее injected (DI) провайдера', () => {
    const injected = makeProvider('injected');
    const resolved = mod.resolveCredentialsProvider(
      {
        ...BASE_OPTIONS,
        auth: createAuth({ type: 'access_token', token: 'tok-auth' }),
      },
      injected,
    );

    expect(resolved).not.toBe(injected);
  });

  it('конфликт auth и driverOptions.credentialsProvider — ошибка', () => {
    expect(() =>
      mod.resolveCredentialsProvider({
        ...BASE_OPTIONS,
        auth: createAuth({ type: 'anonymous' }),
        driverOptions: { credentialsProvider: makeProvider('low-level') },
      }),
    ).toThrow(
      /Conflicting YDB credentials configuration[\s\S]*"auth"[\s\S]*"driverOptions.credentialsProvider"/,
    );
  });

  it('validateYdbModuleOptions: fail-fast на конфликт auth + driverOptions', () => {
    expect(() =>
      mod.validateYdbModuleOptions({
        ...BASE_OPTIONS,
        auth: createAuth({ type: 'anonymous' }),
        driverOptions: { credentialsProvider: makeProvider('low-level') },
      }),
    ).toThrow(/Conflicting YDB credentials configuration/);
  });
});

describe('validateYdbModuleOptions (#96)', () => {
  it('fail-fast на конфликт источников провайдера ещё до создания драйвера', () => {
    expect(() =>
      mod.validateYdbModuleOptions({
        ...BASE_OPTIONS,
        credentialsProvider: makeProvider('custom'),
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

    await mod.createDriver(BASE_OPTIONS, injected);

    const call = StubDriver.calls.at(-1)!;
    expect(call.options.credentialsProvider).toBe(injected);
  });

  it('без кастомных источников создаётся провайдер по auth_type', async () => {
    await mod.createDriver(BASE_OPTIONS);

    const call = StubDriver.calls.at(-1)!;
    expect(call.options.credentialsProvider).toBeInstanceOf(
      AnonymousCredentialsProvider,
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
