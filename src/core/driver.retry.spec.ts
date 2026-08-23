import 'reflect-metadata';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode as Code } from '@ydbjs/api/operation';
import type { YdbModuleOptions } from './interfaces.js';

/**
 * Проводка retry-политики (#27) в createExecutor(): опция retry из
 * YdbModuleOptions реально подключает политику к операциям executor'а.
 * @ydbjs/core и @ydbjs/query подменяются до первого импорта ./driver.js —
 * сети нет, поведение клиента управляется тестом.
 */

const BASE_OPTIONS: YdbModuleOptions = {
  endpoint: 'grpc://localhost:2136/local',
  auth_type: 'anonymous',
  authOptions: {},
};

/** Управляемый фейк QueryClient: режим «скрипт неудач» или «всегда фатально». */
let script: Array<'fail-aborted' | 'ok'> = ['ok'];
let mode: 'script' | 'always-fatal' = 'script';
const executions: number[] = [];

const fakeClient = ((_strings: TemplateStringsArray): unknown => {
  const query: any = {
    parameter() {
      return query;
    },
    timeout() {
      return query;
    },
    signal() {
      return query;
    },
    cancel() {
      return query;
    },
    then(
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      executions.push(executions.length + 1);
      const outcome =
        mode === 'always-fatal'
          ? 'fatal'
          : script[Math.min(executions.length - 1, script.length - 1)];
      const result =
        outcome === 'ok'
          ? Promise.resolve([[{ ok: 1 }]])
          : Promise.reject(
              new YDBError(
                outcome === 'fatal' ? Code.SCHEME_ERROR : Code.ABORTED,
                [],
              ),
            );
      return result.then(onFulfilled, onRejected);
    },
  };
  return query;
}) as unknown as jest.Mock;

class StubDriver {
  async ready(): Promise<void> {}
  close(): void {}
}

type DriverModule = typeof import('./driver.js');
let mod: DriverModule;

beforeAll(async () => {
  jest.unstable_mockModule('@ydbjs/core', () => ({ Driver: StubDriver }));
  jest.unstable_mockModule('@ydbjs/query', () => ({
    query: () => fakeClient,
  }));
  mod = await import('./driver.js');
});

describe('createExecutor(): подключение retry-политики из опций модуля (#27)', () => {
  it('без опции retry поведение прежнее: одна попытка на вызов', async () => {
    script = ['fail-aborted', 'ok'];
    executions.length = 0;
    const executor = mod.createExecutor(
      new StubDriver() as never,
      BASE_OPTIONS,
    );

    await expect(executor`SELECT 1`).rejects.toBeInstanceOf(YDBError);
    // Ретраит только SDK (в фейке цикла нет) — одна попытка:
    expect(executions).toHaveLength(1);
  });

  it('retry: true включает политику с дефолтами', async () => {
    script = ['fail-aborted', 'fail-aborted', 'ok'];
    executions.length = 0;
    const executor = mod.createExecutor(new StubDriver() as never, {
      ...BASE_OPTIONS,
      retry: true,
    });

    await expect(executor`SELECT 1`).resolves.toEqual([[{ ok: 1 }]]);
    // Политика довела операцию до успеха: ровно 3 обращения к БД.
    expect(executions).toHaveLength(3);
  });

  it('детерминированная ошибка политикой не ретраится', async () => {
    script = ['ok'];
    executions.length = 0;
    mode = 'always-fatal';
    const executor = mod.createExecutor(new StubDriver() as never, {
      ...BASE_OPTIONS,
      retry: true,
    });

    await expect(executor`SELECT 1`).rejects.toBeInstanceOf(YDBError);
    // SCHEME_ERROR — детерминированная: одна попытка без повторов.
    expect(executions).toHaveLength(1);
    mode = 'script';
  });
});
