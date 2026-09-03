import 'reflect-metadata';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { CredentialsProvider } from '@ydbjs/auth';
import { createAuth } from '@ycforge/auth';
import type { YdbModuleOptions } from './interfaces.js';

/**
 * Specs for the connection core (#96): priority of CredentialsProvider
 * sources, configuration conflicts, and behavior with AuthManager.
 *
 * The @ydbjs/core module is replaced with a stub BEFORE the first import
 * of ./driver.js (dynamic import after jest.unstable_mockModule), so that
 * createDriver can be called without a network and we can verify which
 * provider reached the Driver constructor.
 */

/** Stub provider with a marker: the resolved source is visible by value. */
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
  it('explicit opts.credentialsProvider used as-is', () => {
    const custom = makeProvider('custom');
    const resolved = mod.resolveCredentialsProvider({
      ...BASE_OPTIONS,
      credentialsProvider: custom,
    });

    expect(resolved).toBe(custom);
  });

  it('opts.auth adapted to CredentialsProvider', () => {
    const resolved = mod.resolveCredentialsProvider({
      endpoint: 'grpc://localhost:2136/local',
      auth: createAuth({ type: 'anonymous' }),
    });

    expect(resolved.constructor.name).toBe('AnonymousCredentialsProvider');
  });

  it('opts.auth: getToken delegates to AuthManager (usage ydb)', async () => {
    const resolved = mod.resolveCredentialsProvider({
      endpoint: 'grpc://localhost:2136/local',
      auth: createAuth({ type: 'access_token', token: 'tok-auth' }),
    });

    await expect(resolved.getToken()).resolves.toBe('tok-auth');
  });

  it('injected (DI) used when no explicit provider or auth', () => {
    const injected = makeProvider('injected');
    const resolved = mod.resolveCredentialsProvider(
      { endpoint: 'grpc://localhost:2136/local' },
      injected,
    );

    expect(resolved).toBe(injected);
  });

  it('driverOptions.credentialsProvider used without explicit sources', () => {
    const lowLevel = makeProvider('low-level');
    const resolved = mod.resolveCredentialsProvider({
      endpoint: 'grpc://localhost:2136/local',
      driverOptions: { credentialsProvider: lowLevel },
    });

    expect(resolved).toBe(lowLevel);
  });

  it('conflict credentialsProvider and driverOptions.credentialsProvider — error', () => {
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

  it('conflict auth and driverOptions.credentialsProvider — error', () => {
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

  it('missing auth and CredentialsProvider — clear error', () => {
    expect(() =>
      mod.resolveCredentialsProvider({
        endpoint: 'grpc://localhost:2136/local',
      }),
    ).toThrow(/YDB auth is required/);
  });
});

describe('resolveCredentialsProvider: priorities', () => {
  it('explicit opts.credentialsProvider takes priority over opts.auth', () => {
    const custom = makeProvider('custom');
    const resolved = mod.resolveCredentialsProvider({
      endpoint: 'grpc://localhost:2136/local',
      credentialsProvider: custom,
      auth: createAuth({ type: 'anonymous' }),
    });

    expect(resolved).toBe(custom);
  });

  it('opts.auth takes priority over injected (DI) provider', () => {
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

  it('injected takes priority over driverOptions.credentialsProvider', () => {
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
  it('fail-fast on provider source conflict before driver creation', () => {
    expect(() =>
      mod.validateYdbModuleOptions({
        endpoint: 'grpc://localhost:2136/local',
        credentialsProvider: makeProvider('custom'),
        driverOptions: { credentialsProvider: makeProvider('low-level') },
      }),
    ).toThrow(/Conflicting YDB credentials configuration/);
  });

  it('fail-fast on auth + driverOptions conflict', () => {
    expect(() =>
      mod.validateYdbModuleOptions({
        endpoint: 'grpc://localhost:2136/local',
        auth: createAuth({ type: 'anonymous' }),
        driverOptions: { credentialsProvider: makeProvider('low-level') },
      }),
    ).toThrow(/Conflicting YDB credentials configuration/);
  });
});

describe('createDriver (#96): provider reaches Driver', () => {
  it('explicit opts.credentialsProvider passed to driver constructor', async () => {
    const custom = makeProvider('custom');

    await mod.createDriver({
      ...BASE_OPTIONS,
      credentialsProvider: custom,
    });

    const call = StubDriver.calls.at(-1)!;
    expect(call.options.credentialsProvider).toBe(custom);
  });

  it('createDriver() argument (NestJS DI path) reaches driver', async () => {
    const injected = makeProvider('injected');

    await mod.createDriver(
      { endpoint: 'grpc://localhost:2136/local' },
      injected,
    );

    const call = StubDriver.calls.at(-1)!;
    expect(call.options.credentialsProvider).toBe(injected);
  });

  it('without custom sources auth (AuthManager) is used', async () => {
    await mod.createDriver(BASE_OPTIONS);

    const call = StubDriver.calls.at(-1)!;
    expect(call.options.credentialsProvider.constructor.name).toBe(
      'AnonymousCredentialsProvider',
    );
  });

  it('conflict caught fail-fast: no silent substitution of explicit provider', async () => {
    const custom = makeProvider('custom');

    await expect(
      mod.createDriver({
        ...BASE_OPTIONS,
        credentialsProvider: custom,
        driverOptions: { credentialsProvider: makeProvider('low-level') },
      }),
    ).rejects.toThrow(/Conflicting YDB credentials configuration/);
  });

  it('missing auth and CredentialsProvider — clear error', async () => {
    await expect(
      mod.createDriver({ endpoint: 'grpc://localhost:2136/local' }),
    ).rejects.toThrow(/YDB auth is required/);
  });

  it('other driverOptions preserved alongside resolved provider', async () => {
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
