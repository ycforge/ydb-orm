import { describe, it, expect } from '@jest/globals';
import { YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode as Code } from '@ydbjs/api/operation';
import { withRetryPolicy } from './retry-executor.js';
import type {
  YdbExecutor,
  YdbQuery,
  YdbTransactionOptions,
  YdbTransactionHandle,
} from './interfaces.js';
import type { YdbRetrySleepFn } from './retry.js';

/**
 * Integration tests for wiring the retry policy into an executor (#27):
 * the policy is actually invoked for executor operations, attempts do not
 * multiply with the SDK's internal retry, and classification/cancellation work.
 */

function ydbErr(code: number): YDBError {
  return new YDBError(code, []);
}

function recordingSleep(): { sleep: YdbRetrySleepFn; delays: number[] } {
  const delays: number[] = [];
  const sleep: YdbRetrySleepFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

/** Simple fake query: no SDK events, behavior is set by the test. */
interface FakeQueryState {
  signals: Array<AbortSignal | undefined>;
  paramsList: Array<Record<string, unknown>>;
}

function makeSimpleFlakyExecutor(
  script: Array<'fail-aborted' | 'ok'>,
  state: FakeQueryState,
): YdbExecutor {
  let call = 0;
  const executor = ((
    strings: TemplateStringsArray,
    ...args: any[]
  ): YdbQuery => {
    const idx = Math.min(call, script.length - 1);
    const outcome = script[idx];
    call += 1;

    const recorded: Record<string, unknown> = {};
    let signal: AbortSignal | undefined;
    void strings;
    void args;
    const query: any = {
      parameter(name: string, value: unknown) {
        recorded[name] = value;
        return query;
      },
      timeout() {
        return query;
      },
      signal(s: AbortSignal) {
        signal = s;
        return query;
      },
      cancel() {
        return query;
      },
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        state.signals.push(signal);
        state.paramsList.push(recorded);
        const result =
          outcome === 'ok'
            ? Promise.resolve([[{ id: 'x' }]])
            : Promise.reject(ydbErr(Code.ABORTED));
        return result.then(onFulfilled, onRejected);
      },
    };
    return query;
  }) as unknown as YdbExecutor;

  return executor;
}

describe('withRetryPolicy(): policy invoked via executor operations', () => {
  it('disabled policy returns executor as-is (#98 unchanged)', () => {
    const base = makeSimpleFlakyExecutor(['ok'], {
      signals: [],
      paramsList: [],
    });
    expect(withRetryPolicy(base, false)).toBe(base);
    expect(withRetryPolicy(base, undefined)).toBe(base);
  });

  it('transient errors retried: three executions, parameters reproduced', async () => {
    const { sleep, delays } = recordingSleep();
    const state: FakeQueryState = { signals: [], paramsList: [] };
    // fail, fail, ok — and then ok (in case of excess attempts)
    const base = makeSimpleFlakyExecutor(
      ['fail-aborted', 'fail-aborted', 'ok'],
      state,
    );
    const wrapped = withRetryPolicy(base, {
      jitterRatio: 0,
      rng: () => 0,
      sleep,
    });

    const rows = await wrapped`SELECT * FROM users WHERE id = ${'u1'}`
      .parameter(':p1', 'v1')
      .idempotent(true);

    expect(rows).toEqual([[{ id: 'x' }]]);
    expect(state.paramsList).toHaveLength(3);
    // Builder parameters are reproduced on each policy attempt:
    for (const params of state.paramsList) {
      expect(params).toEqual({ ':p1': 'v1' });
    }
    // Policy delays: 100 -> 200 (defaults, jitter disabled).
    expect(delays).toEqual([100, 200]);
  });

  it('deterministic error not retried — single execution', async () => {
    const { sleep } = recordingSleep();
    const boom = ydbErr(Code.BAD_REQUEST);
    let calls = 0;
    const base = ((strings: TemplateStringsArray): YdbQuery => {
      void strings;
      calls += 1;
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
          return Promise.reject(boom).then(onFulfilled, onRejected);
        },
      };
      return query;
    }) as unknown as YdbExecutor;

    await expect(withRetryPolicy(base, { sleep })`SELECT 1`).rejects.toBe(boom);
    expect(calls).toBe(1);
  });

  it('maxAttempts exhaustion: exactly N executions, last error as-is', async () => {
    const { sleep } = recordingSleep();
    const state: FakeQueryState = { signals: [], paramsList: [] };
    const base = makeSimpleFlakyExecutor(['fail-aborted'], state);

    const last = new Error('last');
    // The last error cannot be swapped out (the script always aborts) — we
    // check the execution count: exactly maxAttempts, without multiplication.
    await expect(
      withRetryPolicy(base, { maxAttempts: 4, sleep })`SELECT 1`.idempotent(
        true,
      ),
    ).rejects.toBeInstanceOf(YDBError);
    expect(state.signals).toHaveLength(4);
    void last;
  });
});

describe('withRetryPolicy(): cancellation and attempt signals', () => {
  function honoringSleep(): { sleep: YdbRetrySleepFn } {
    const sleep: YdbRetrySleepFn = (_ms, signal) => {
      if (signal?.aborted) {
        const reason = signal.reason;
        return Promise.reject(
          reason instanceof Error ? reason : new Error('aborted'),
        );
      }
      return Promise.resolve();
    };
    return { sleep };
  }

  it('user signal reaches every query attempt', async () => {
    const { sleep } = honoringSleep();
    const controller = new AbortController();
    const state: FakeQueryState = { signals: [], paramsList: [] };
    const base = makeSimpleFlakyExecutor(['ok'], state);
    const wrapped = withRetryPolicy(base, { sleep });

    await wrapped`SELECT 1`.signal(controller.signal);

    // The single attempt received the policy's linked per-attempt signal:
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0]).toBeInstanceOf(AbortSignal);
    expect(controller.signal.aborted).toBe(false);
  });

  it('cancellation during backoff stops operation with cancellation reason', async () => {
    const { sleep } = honoringSleep();
    const controller = new AbortController();
    const state: FakeQueryState = { signals: [], paramsList: [] };
    const base = makeSimpleFlakyExecutor(['fail-aborted'], state);

    let pendingReject: unknown;
    const pending = Promise.resolve(
      withRetryPolicy(base, {
        maxAttempts: 5,
        jitterRatio: 0,
        rng: () => 0,
        sleep,
        signal: controller.signal,
        onRetry: () => controller.abort(new Error('stop-after-first-attempt')),
      })`SELECT 1`.idempotent(true),
    );
    pending.catch((error: unknown) => {
      pendingReject = error;
    });

    await expect(pending).rejects.toMatchObject({
      message: 'stop-after-first-attempt',
    });
    void pendingReject;
    // Exactly one DB attempt: cancellation blocked the second.
    expect(state.signals).toHaveLength(1);
  });

  it('already aborted policy signal — zero DB calls', async () => {
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const state: FakeQueryState = { signals: [], paramsList: [] };
    const base = makeSimpleFlakyExecutor(['ok'], state);
    const wrapped = withRetryPolicy(base, {
      sleep,
      signal: controller.signal,
    });

    await expect(wrapped`SELECT 1`.idempotent(true)).rejects.toBeInstanceOf(
      Error,
    );
    expect(state.signals).toHaveLength(0);
  });
});

describe('withRetryPolicy(): silencing SDK internal retry (retry event)', () => {
  /**
   * Imitates an SDK query (@ydbjs/query): the internal loop wants to retry
   * a transient error forever; the 'retry' event fires after the delay,
   * and the next attempt starts with a throwIfAborted check on the query
   * signal.
   */
  function makeSdkLikeExecutor(options: {
    failuresBeforeSuccess: number;
    executions: number[];
  }): YdbExecutor {
    let failureCount = 0;
    const executor = ((_strings: TemplateStringsArray): YdbQuery => {
      const listeners: Array<(ctx: unknown) => void> = [];
      let signal: AbortSignal | undefined;
      const query: any = {
        parameter() {
          return query;
        },
        timeout() {
          return query;
        },
        signal(s: AbortSignal) {
          signal = s;
          return query;
        },
        cancel() {
          return query;
        },
        on(event: string, listener: (ctx: unknown) => void) {
          if (event === 'retry') listeners.push(listener);
          return query;
        },
        then(
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve()
            .then((): unknown => {
              if (signal?.aborted) {
                const abortError = new Error('The operation was aborted');
                abortError.name = 'AbortError';
                throw abortError;
              }
              if (failureCount < options.failuresBeforeSuccess) {
                failureCount += 1;
                options.executions.push(failureCount);
                const boom = ydbErr(Code.ABORTED);
                // SDK strategy decides to retry: event after the delay.
                for (const listener of listeners) {
                  listener({ attempt: failureCount, error: boom });
                }
                // The policy cancelled the signal — no next attempt:
                if (signal?.aborted) {
                  const abortError = new Error('The operation was aborted');
                  abortError.name = 'AbortError';
                  throw abortError;
                }
                throw boom;
              }
              options.executions.push(failureCount + 1);
              return [[{ done: true }]];
            })
            .then(onFulfilled, onRejected);
        },
      };
      return query;
    }) as unknown as YdbExecutor;
    return executor;
  }

  it('one policy attempt = one SDK attempt: attempts do NOT multiply', async () => {
    const { sleep } = recordingSleep();
    const executions: number[] = [];
    const base = makeSdkLikeExecutor({
      failuresBeforeSuccess: 2,
      executions,
    });
    const wrapped = withRetryPolicy(base, {
      maxAttempts: 5,
      jitterRatio: 0,
      rng: () => 0,
      sleep,
    });

    await expect(wrapped`SELECT 1`.idempotent(true)).resolves.toEqual([
      [{ done: true }],
    ]);
    // Two transient failures + success = EXACTLY 3 DB calls. The SDK's
    // internal loop (unbounded budget) is silenced by the policy: without
    // silencing, each policy attempt would spin in the SDK's infinite loop.
    expect(executions).toEqual([1, 2, 3]);
  });

  it('original error reaches policy, not AbortError from cancellation', async () => {
    const { sleep } = recordingSleep();
    const executions: number[] = [];
    const base = makeSdkLikeExecutor({ failuresBeforeSuccess: 1, executions });
    const seenErrors: unknown[] = [];
    const wrapped = withRetryPolicy(base, {
      maxAttempts: 2,
      jitterRatio: 0,
      rng: () => 0,
      sleep,
      onRetry: (ctx) => {
        seenErrors.push(ctx.error);
      },
    });

    await expect(wrapped`SELECT 1`.idempotent(true)).resolves.toEqual([
      [{ done: true }],
    ]);
    // The policy saw exactly the YDBError ABORTED, not a substituted AbortError:
    expect(seenErrors).toHaveLength(1);
    expect(seenErrors[0]).toBeInstanceOf(YDBError);
  });
});

describe('withRetryPolicy(): transaction() passed through as-is', () => {
  it('transaction handle not wrapped by policy', async () => {
    const openedOptions: YdbTransactionOptions[] = [];
    const handle: YdbTransactionHandle = {
      execute: async (fn) =>
        fn((() => {}) as unknown as YdbExecutor, undefined),
    };
    const base = ((_strings: TemplateStringsArray): YdbQuery => {
      throw new Error('should not be called');
    }) as unknown as YdbExecutor;
    (base as unknown as Record<string, unknown>).transaction = (
      options?: YdbTransactionOptions,
    ) => {
      openedOptions.push(options ?? {});
      return handle;
    };

    const wrapped = withRetryPolicy(base, { maxAttempts: 3 });
    await wrapped.transaction({ idempotent: true }).execute((trx) => {
      void trx;
      return Promise.resolve('tx');
    });

    expect(openedOptions).toEqual([{ idempotent: true }]);
  });
});

describe('withRetryPolicy(): idempotency rule (#27, fail-safe)', () => {
  /**
   * SDK-like query with an internal "infinite" retry loop (like
   * @ydbjs/query): always-retried statuses retry regardless of the
   * idempotent flag, the 'retry' event fires after each failure, and the
   * next attempt runs only while the signal is live.
   * realExecutions — counter of REAL DB calls.
   */
  function makeSdkLikeExecutor(options: {
    failuresBeforeSuccess: number;
    statusCodes: number[];
    realExecutions: number[];
    idempotentMarks: boolean[];
  }): YdbExecutor {
    let failures = 0;
    const executor = ((_strings: TemplateStringsArray): YdbQuery => {
      void _strings;
      const listeners: Array<(ctx: unknown) => void> = [];
      let signal: AbortSignal | undefined;
      const query: any = {
        parameter() {
          return query;
        },
        timeout() {
          return query;
        },
        signal(s: AbortSignal) {
          signal = s;
          return query;
        },
        idempotent(flag?: boolean) {
          options.idempotentMarks.push(flag !== false);
          return query;
        },
        cancel() {
          return query;
        },
        on(event: string, listener: (ctx: unknown) => void) {
          if (event === 'retry') listeners.push(listener);
          return query;
        },
        then(
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve()
            .then((): unknown => {
              if (signal?.aborted) {
                const abortError = new Error('The operation was aborted');
                abortError.name = 'AbortError';
                throw abortError;
              }
              if (failures < options.failuresBeforeSuccess) {
                const code =
                  options.statusCodes[
                    Math.min(failures, options.statusCodes.length - 1)
                  ];
                failures += 1;
                options.realExecutions.push(failures);
                const boom = new YDBError(code, []);
                for (const listener of listeners) {
                  listener({ attempt: failures, error: boom });
                }
                // The policy silenced the internal loop — no next attempt:
                if (signal?.aborted) {
                  const abortError = new Error('The operation was aborted');
                  abortError.name = 'AbortError';
                  throw abortError;
                }
                throw boom;
              }
              options.realExecutions.push(failures + 1);
              return [[{ done: true }]];
            })
            .then(onFulfilled, onRejected);
        },
      };
      return query;
    }) as unknown as YdbExecutor;
    return executor;
  }

  const TRANSIENT = [Code.ABORTED, Code.UNAVAILABLE, Code.OVERLOADED];

  it('(1) unmarked query + transient error → exactly one DB attempt', async () => {
    const { sleep } = recordingSleep();
    const realExecutions: number[] = [];
    const base = makeSdkLikeExecutor({
      failuresBeforeSuccess: 50,
      statusCodes: TRANSIENT,
      realExecutions,
      idempotentMarks: [],
    });
    const wrapped = withRetryPolicy(base, {
      maxAttempts: 3,
      jitterRatio: 0,
      rng: () => 0,
      sleep,
    });

    await expect(wrapped`UPSERT users SET ...`).rejects.toBeInstanceOf(
      YDBError,
    );
    // The SDK's internal loop wants to retry forever — the policy silences
    // it: EXACTLY one DB call, a write retry is impossible.
    expect(realExecutions).toHaveLength(1);
  });

  it('(2) idempotent-marked query retried up to maxAttempts', async () => {
    const { sleep } = recordingSleep();
    const realExecutions: number[] = [];
    const marks: boolean[] = [];
    const base = makeSdkLikeExecutor({
      failuresBeforeSuccess: 2,
      statusCodes: TRANSIENT,
      realExecutions,
      idempotentMarks: marks,
    });
    const wrapped = withRetryPolicy(base, {
      maxAttempts: 3,
      jitterRatio: 0,
      rng: () => 0,
      sleep,
    });

    await expect(
      wrapped`SELECT * FROM users`.idempotent(true),
    ).resolves.toEqual([[{ done: true }]]);
    expect(realExecutions).toEqual([1, 2, 3]);
    // The flag is forwarded to the SDK query on each attempt:
    expect(marks).toEqual([true, true, true]);
  });

  it('(3) unmarked write not retried for any transient status', async () => {
    for (const code of TRANSIENT) {
      const { sleep } = recordingSleep();
      const realExecutions: number[] = [];
      const base = makeSdkLikeExecutor({
        failuresBeforeSuccess: 5,
        statusCodes: [code],
        realExecutions,
        idempotentMarks: [],
      });
      const wrapped = withRetryPolicy(base, { maxAttempts: 3, sleep });

      await expect(wrapped`INSERT INTO t ...`).rejects.toBeInstanceOf(YDBError);
      expect(realExecutions).toHaveLength(1);
    }
  });

  it('(4) marked query retried for each transient status', async () => {
    for (const code of TRANSIENT) {
      const { sleep } = recordingSleep();
      const realExecutions: number[] = [];
      const base = makeSdkLikeExecutor({
        failuresBeforeSuccess: 1,
        statusCodes: [code],
        realExecutions,
        idempotentMarks: [],
      });
      const wrapped = withRetryPolicy(base, { maxAttempts: 2, sleep });

      await expect(wrapped`SELECT 1`.idempotent(true)).resolves.toEqual([
        [{ done: true }],
      ]);
      expect(realExecutions).toHaveLength(2);
    }
  });

  it('(5) policy and SDK attempts do not multiply in either direction', async () => {
    // a) unmarked: one real call despite the SDK's "eternal" wish to retry.
    {
      const { sleep } = recordingSleep();
      const realExecutions: number[] = [];
      const base = makeSdkLikeExecutor({
        failuresBeforeSuccess: Number.POSITIVE_INFINITY,
        statusCodes: [Code.ABORTED],
        realExecutions,
        idempotentMarks: [],
      });
      await expect(
        withRetryPolicy(base, { maxAttempts: 10, sleep })`UPDATE t SET x = 1`,
      ).rejects.toBeInstanceOf(YDBError);
      expect(realExecutions).toHaveLength(1);
    }
    // b) marked: exhausts exactly at maxAttempts, without extra SDK attempts.
    {
      const { sleep } = recordingSleep();
      const realExecutions: number[] = [];
      const base = makeSdkLikeExecutor({
        failuresBeforeSuccess: 5,
        statusCodes: [Code.ABORTED],
        realExecutions,
        idempotentMarks: [],
      });
      const wrapped = withRetryPolicy(base, {
        maxAttempts: 3,
        jitterRatio: 0,
        rng: () => 0,
        sleep,
      });
      await expect(
        wrapped`DELETE FROM t ...`.idempotent(true),
      ).rejects.toBeInstanceOf(YDBError);
      expect(realExecutions).toHaveLength(3);
    }
  });

  it('.idempotent(false)/no mark — single execution; mark reaches SDK', async () => {
    const { sleep } = recordingSleep();
    const marks: boolean[] = [];
    const realExecutions: number[] = [];
    const base = makeSdkLikeExecutor({
      failuresBeforeSuccess: 3,
      statusCodes: TRANSIENT,
      realExecutions,
      idempotentMarks: marks,
    });

    await expect(
      withRetryPolicy(base, { maxAttempts: 5, sleep })`SELECT 1`.idempotent(
        false,
      ),
    ).rejects.toBeInstanceOf(YDBError);
    expect(realExecutions).toHaveLength(1);

    // Successful marked query: the flag reached the SDK query.
    const okBase = makeSdkLikeExecutor({
      failuresBeforeSuccess: 0,
      statusCodes: TRANSIENT,
      realExecutions: [],
      idempotentMarks: marks,
    });
    await withRetryPolicy(okBase, { sleep })`SELECT 2`.idempotent(true);
    expect(marks).toContain(true);
  });
});
