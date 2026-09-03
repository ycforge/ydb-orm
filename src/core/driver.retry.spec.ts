import 'reflect-metadata';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createAuth } from '@ycforge/auth';
import { YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode as Code } from '@ydbjs/api/operation';
import type { YdbModuleOptions } from './interfaces.js';

/**
 * Wiring the retry policy (#27) into createExecutor(): the retry option
 * from YdbModuleOptions actually attaches the policy to executor operations.
 * @ydbjs/core and @ydbjs/query are replaced before the first import of
 * ./driver.js — there is no network, client behavior is driven by the test.
 */

const BASE_OPTIONS: YdbModuleOptions = {
  endpoint: 'grpc://localhost:2136/local',
  auth: createAuth({ type: 'anonymous' }),
};

/** Controllable fake QueryClient: "failure script" mode or "always fatal". */
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

describe('createExecutor(): wiring retry policy from module options (#27)', () => {
  it('without retry option behavior unchanged: one attempt per call', async () => {
    script = ['fail-aborted', 'ok'];
    executions.length = 0;
    const executor = mod.createExecutor(
      new StubDriver() as never,
      BASE_OPTIONS,
    );

    await expect(executor`SELECT 1`).rejects.toBeInstanceOf(YDBError);
    // Only the SDK retries (no loop in the fake) — a single attempt:
    expect(executions).toHaveLength(1);
  });

  it('retry: true enables policy with defaults', async () => {
    script = ['fail-aborted', 'fail-aborted', 'ok'];
    executions.length = 0;
    const executor = mod.createExecutor(new StubDriver() as never, {
      ...BASE_OPTIONS,
      retry: true,
    });

    await expect(executor`SELECT 1`.idempotent(true)).resolves.toEqual([
      [{ ok: 1 }],
    ]);
    // The policy carried the operation to success: exactly 3 DB calls.
    expect(executions).toHaveLength(3);
  });

  it('deterministic error not retried by policy', async () => {
    script = ['ok'];
    executions.length = 0;
    mode = 'always-fatal';
    const executor = mod.createExecutor(new StubDriver() as never, {
      ...BASE_OPTIONS,
      retry: true,
    });

    await expect(executor`SELECT 1`).rejects.toBeInstanceOf(YDBError);
    // SCHEME_ERROR is deterministic: a single attempt with no retries.
    expect(executions).toHaveLength(1);
    mode = 'script';
  });
});
