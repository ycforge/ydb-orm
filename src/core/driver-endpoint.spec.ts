import 'reflect-metadata';
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { CredentialsProvider } from '@ydbjs/auth';
import { createAuth } from '@ycforge/auth';

/**
 * Регрессия #244: endpoint нормализуется (trim) до вывода `secure`, поэтому
 * адаптер AuthManager (@ycforge/auth/ydb) и драйвер видят один транспорт.
 *
 * @ydbjs/core и @ycforge/auth/ydb подменяются ДО первого импорта ./driver.js:
 * адаптер фиксирует полученные endpoint/secure, а StubDriver — endpoint,
 * переданный в конструктор. Сети нет.
 */

const adapterCalls: Array<{ endpoint?: string; secure?: boolean }> = [];

/** Реальная AuthManager-конфигурация: адаптер подменён, важна лишь её форма. */
function staticAuth() {
  return createAuth({ type: 'static', username: 'user', password: 'pass' });
}

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
  jest.unstable_mockModule('@ydbjs/core', () => ({ Driver: StubDriver }));
  jest.unstable_mockModule('@ycforge/auth/ydb', () => ({
    createYdbCredentialsProvider: (
      _auth: unknown,
      _usage: unknown,
      options: { endpoint?: string; secure?: boolean } = {},
    ) => {
      adapterCalls.push({ endpoint: options.endpoint, secure: options.secure });
      return {
        getToken: () => Promise.resolve('token:auth'),
      } as unknown as CredentialsProvider;
    },
  }));
  mod = await import('./driver.js');
});

beforeEach(() => {
  StubDriver.calls = [];
  adapterCalls.length = 0;
});

describe('normalizeEndpoint (#244)', () => {
  it('срезает пробелы по краям', () => {
    expect(mod.normalizeEndpoint('  grpc://localhost:2136/local\t')).toBe(
      'grpc://localhost:2136/local',
    );
  });

  it('оставляет endpoint без пробелов неизменным', () => {
    expect(mod.normalizeEndpoint('grpcs://ydb.example:2135/local')).toBe(
      'grpcs://ydb.example:2135/local',
    );
  });
});

describe('secure выводится из нормализованного endpoint (#244)', () => {
  it('grpc:// с пробелами → secure false, endpoint обрезан', () => {
    mod.resolveCredentialsProvider({
      endpoint: ' grpc://localhost:2136/local ',
      auth: staticAuth(),
    });

    expect(adapterCalls.at(-1)).toEqual({
      endpoint: 'grpc://localhost:2136/local',
      secure: false,
    });
  });

  it('grpcs:// с пробелами → secure true, endpoint обрезан', () => {
    mod.resolveCredentialsProvider({
      endpoint: '\tgrpcs://ydb.example:2135/local\n',
      auth: staticAuth(),
    });

    expect(adapterCalls.at(-1)).toEqual({
      endpoint: 'grpcs://ydb.example:2135/local',
      secure: true,
    });
  });

  it('grpc:// без пробелов → secure false, endpoint неизменен', () => {
    mod.resolveCredentialsProvider({
      endpoint: 'grpc://localhost:2136/local',
      auth: staticAuth(),
    });

    expect(adapterCalls.at(-1)).toEqual({
      endpoint: 'grpc://localhost:2136/local',
      secure: false,
    });
  });

  it('grpcs:// без пробелов → secure true, endpoint неизменен', () => {
    mod.resolveCredentialsProvider({
      endpoint: 'grpcs://ydb.example:2135/local',
      auth: staticAuth(),
    });

    expect(adapterCalls.at(-1)).toEqual({
      endpoint: 'grpcs://ydb.example:2135/local',
      secure: true,
    });
  });
});

describe('createDriver: драйвер и адаптер согласованы (#244)', () => {
  it('grpc:// с пробелами: оба получают обрезанный insecure endpoint', async () => {
    await mod.createDriver({
      endpoint: ' grpc://localhost:2136/local ',
      auth: staticAuth(),
    });

    expect(StubDriver.calls.at(-1)!.endpoint).toBe(
      'grpc://localhost:2136/local',
    );
    expect(adapterCalls.at(-1)).toEqual({
      endpoint: 'grpc://localhost:2136/local',
      secure: false,
    });
  });

  it('grpcs:// с пробелами: оба получают обрезанный secure endpoint', async () => {
    await mod.createDriver({
      endpoint: ' grpcs://ydb.example:2135/local ',
      auth: staticAuth(),
    });

    expect(StubDriver.calls.at(-1)!.endpoint).toBe(
      'grpcs://ydb.example:2135/local',
    );
    expect(adapterCalls.at(-1)).toEqual({
      endpoint: 'grpcs://ydb.example:2135/local',
      secure: true,
    });
  });
});

describe('явный CredentialsProvider не затронут (#244)', () => {
  it('адаптер не вызывается, провайдер передаётся как есть', async () => {
    const custom = {
      getToken: () => Promise.resolve('token:custom'),
    } as unknown as CredentialsProvider;

    const resolved = mod.resolveCredentialsProvider({
      endpoint: ' grpc://localhost:2136/local ',
      credentialsProvider: custom,
    });
    expect(resolved).toBe(custom);
    expect(adapterCalls).toHaveLength(0);

    await mod.createDriver({
      endpoint: ' grpc://localhost:2136/local ',
      credentialsProvider: custom,
    });
    expect(StubDriver.calls.at(-1)!.options.credentialsProvider).toBe(custom);
    expect(adapterCalls).toHaveLength(0);
  });
});
