import { describe, it, expect, jest } from '@jest/globals';
import { CommitError, YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode as Code } from '@ydbjs/api/operation';
import {
  classifyYdbError,
  computeRetryDelayMs,
  isTransientYdbError,
  runWithRetry,
  validateYdbRetryPolicyOptions,
  DEFAULT_YDB_RETRY_POLICY_OPTIONS,
  TRANSIENT_YDB_STATUSES,
} from './retry.js';
import type { YdbRetrySleepFn } from './retry.js';
import type { YdbExecutor } from '../core/interfaces.js';

/**
 * Unit tests for the error-type-driven retry policy (#27): classification
 * strictly by YDB structural status codes, attempt limiting, bounded
 * exponential backoff + jitter, cancellation via AbortSignal, and the
 * absence of hidden retry around transactions (#98). All delays are
 * injected — no real sleeping, so the tests are deterministic.
 */

/** A YDB error with the given status code (structural classification). */
function ydbErr(code: number): YDBError {
  return new YDBError(code, []);
}

/** Recording sleep: instead of sleeping, accumulates the computed delays. */
function recordingSleep(): { sleep: YdbRetrySleepFn; delays: number[] } {
  const delays: number[] = [];
  const sleep: YdbRetrySleepFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

/** Deterministic rng: yields values from the queue cyclically. */
function seqRng(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('classifyYdbError(): classification by status codes (#27)', () => {
  it('only ABORTED/UNAVAILABLE/OVERLOADED are transient', () => {
    expect([...TRANSIENT_YDB_STATUSES].sort((a, b) => a - b)).toEqual(
      [Code.ABORTED, Code.UNAVAILABLE, Code.OVERLOADED].sort((a, b) => a - b),
    );
    expect(classifyYdbError(ydbErr(Code.ABORTED))).toBe('transient');
    expect(classifyYdbError(ydbErr(Code.UNAVAILABLE))).toBe('transient');
    expect(classifyYdbError(ydbErr(Code.OVERLOADED))).toBe('transient');
    expect(isTransientYdbError(ydbErr(Code.OVERLOADED))).toBe(true);
  });

  it('statuses that the SDK retries are NOT retried by the policy (policy is stricter)', () => {
    // BAD_SESSION/SESSION_BUSY the SDK always retries internally — the ORM
    // policy must not duplicate that; otherwise attempts multiply.
    expect(classifyYdbError(ydbErr(Code.BAD_SESSION))).toBe('fatal');
    expect(classifyYdbError(ydbErr(Code.SESSION_BUSY))).toBe('fatal');
    // Conditionally retryable in the SDK — fatal for the policy:
    expect(classifyYdbError(ydbErr(Code.SESSION_EXPIRED))).toBe('fatal');
    expect(classifyYdbError(ydbErr(Code.UNDETERMINED))).toBe('fatal');
    expect(classifyYdbError(ydbErr(Code.TIMEOUT))).toBe('fatal');
  });

  it('deterministic application/schema/query errors are fatal', () => {
    const deterministic = [
      Code.BAD_REQUEST,
      Code.UNAUTHORIZED,
      Code.INTERNAL_ERROR,
      Code.SCHEME_ERROR,
      Code.GENERIC_ERROR,
      Code.PRECONDITION_FAILED,
      Code.ALREADY_EXISTS,
      Code.NOT_FOUND,
      Code.UNSUPPORTED,
      Code.EXTERNAL_ERROR,
      Code.CANCELLED,
    ];
    for (const code of deterministic) {
      expect(classifyYdbError(ydbErr(code))).toBe('fatal');
    }
  });

  it('CommitError is unwrapped to the cause (structurally, without text)', () => {
    expect(
      classifyYdbError(new CommitError('commit failed', ydbErr(Code.ABORTED))),
    ).toBe('transient');
    expect(
      classifyYdbError(
        new CommitError('commit failed', ydbErr(Code.SCHEME_ERROR)),
      ),
    ).toBe('fatal');
    expect(classifyYdbError(new CommitError('commit failed'))).toBe('fatal');
  });

  it('everything non-YDB (application errors, cancellations) is fatal', () => {
    const named = (name: string): Error =>
      Object.assign(new Error(name), { name });

    expect(classifyYdbError(new Error('application error'))).toBe('fatal');
    expect(classifyYdbError(new TypeError('x is not a function'))).toBe(
      'fatal',
    );
    expect(classifyYdbError('thrown string')).toBe('fatal');
    expect(classifyYdbError(undefined)).toBe('fatal');
    expect(classifyYdbError(named('AbortError'))).toBe('fatal');
    expect(classifyYdbError(named('TimeoutError'))).toBe('fatal');
  });
});

describe('computeRetryDelayMs(): bounded exponential backoff + jitter', () => {
  it('exponential growth without jitter: base, 2*base, 4*base...', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0 };
    expect(computeRetryDelayMs(1, opts, seqRng([0]))).toBe(100);
    expect(computeRetryDelayMs(2, opts, seqRng([0]))).toBe(200);
    expect(computeRetryDelayMs(3, opts, seqRng([0]))).toBe(400);
    expect(computeRetryDelayMs(4, opts, seqRng([0]))).toBe(800);
  });

  it('growth is bounded by maxDelayMs', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 2500, jitterRatio: 0 };
    expect(computeRetryDelayMs(1, opts, seqRng([0]))).toBe(1000);
    expect(computeRetryDelayMs(2, opts, seqRng([0]))).toBe(2000);
    expect(computeRetryDelayMs(3, opts, seqRng([0]))).toBe(2500);
    expect(computeRetryDelayMs(10, opts, seqRng([0]))).toBe(2500);
  });

  it('jitter compresses delay down to [(1-r)*raw, raw]', () => {
    const opts = { baseDelayMs: 200, maxDelayMs: 10_000, jitterRatio: 0.5 };
    expect(computeRetryDelayMs(1, opts, seqRng([0]))).toBe(100); // lower bound
    expect(computeRetryDelayMs(1, opts, seqRng([0.999999]))).toBe(200); // upper bound
    expect(computeRetryDelayMs(1, opts, seqRng([0.5]))).toBe(150);
  });

  it('jitter never exceeds raw and maxDelayMs', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 300, jitterRatio: 1 };
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const delay = computeRetryDelayMs(attempt, opts, seqRng([0.99]));
      expect(delay).toBeLessThanOrEqual(
        Math.min(100 * 2 ** (attempt - 1), 300),
      );
    }
  });

  it('defaults are used when no options provided', () => {
    // Defaults: base 100, jitterRatio 0.25; rng -> 0 gives the lower bound of
    // the jitter corridor: round(100 * (1 - 0.25)) = 75.
    expect(computeRetryDelayMs(1, undefined, seqRng([0]))).toBe(75);
  });
});

describe('validateYdbRetryPolicyOptions(): fail-fast validation', () => {
  it('undefined and valid options pass', () => {
    expect(() => validateYdbRetryPolicyOptions(undefined)).not.toThrow();
    const signal = new AbortController().signal;
    expect(() =>
      validateYdbRetryPolicyOptions({
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterRatio: 0.5,
        signal,
        onRetry: () => {},
        shouldRetry: () => true,
        sleep: () => Promise.resolve(),
        rng: () => 0,
      }),
    ).not.toThrow();
  });

  it('invalid values are rejected immediately', async () => {
    expect(() => validateYdbRetryPolicyOptions(null as never)).toThrow();
    expect(() => validateYdbRetryPolicyOptions(42 as never)).toThrow();
    expect(() => validateYdbRetryPolicyOptions({ maxAttempts: 0 })).toThrow(
      /maxAttempts/,
    );
    expect(() => validateYdbRetryPolicyOptions({ maxAttempts: 2.5 })).toThrow(
      /maxAttempts/,
    );
    expect(() =>
      validateYdbRetryPolicyOptions({ maxAttempts: Number.NaN }),
    ).toThrow(/maxAttempts/);
    expect(() => validateYdbRetryPolicyOptions({ baseDelayMs: 0 })).toThrow(
      /baseDelayMs/,
    );
    expect(() => validateYdbRetryPolicyOptions({ baseDelayMs: -1 })).toThrow(
      /baseDelayMs/,
    );
    expect(() => validateYdbRetryPolicyOptions({ maxDelayMs: 0 })).toThrow(
      /maxDelayMs/,
    );
    expect(() => validateYdbRetryPolicyOptions({ jitterRatio: -0.1 })).toThrow(
      /jitterRatio/,
    );
    expect(() => validateYdbRetryPolicyOptions({ jitterRatio: 1.5 })).toThrow(
      /jitterRatio/,
    );
    expect(() =>
      validateYdbRetryPolicyOptions({ signal: 'nope' as never }),
    ).toThrow(/signal/);
    expect(() =>
      validateYdbRetryPolicyOptions({ onRetry: 'nope' as never }),
    ).toThrow(/onRetry/);
    // runWithRetry validates options before the first attempt:
    await expect(
      runWithRetry(() => Promise.resolve(1), { maxAttempts: 0 }),
    ).rejects.toThrow(/maxAttempts/);
  });
});

describe('runWithRetry(): retries only transient errors (#27)', () => {
  it('success on first attempt — fn called once', async () => {
    const { sleep, delays } = recordingSleep();
    const fn = jest.fn(() => Promise.resolve('ok'));

    await expect(runWithRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('transient error then success — exactly one retry', async () => {
    const { sleep, delays } = recordingSleep();
    const boom = ydbErr(Code.ABORTED);
    let calls = 0;
    const fn = jest.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(boom) : Promise.resolve('recovered');
    });

    await expect(
      runWithRetry(fn, { sleep, jitterRatio: 0, rng: seqRng([0]) }),
    ).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    // Default base is 100 ms, jitter explicitly disabled:
    expect(delays).toEqual([DEFAULT_YDB_RETRY_POLICY_OPTIONS.baseDelayMs]);
  });

  it('deterministic/application error is propagated immediately', async () => {
    const { sleep, delays } = recordingSleep();

    for (const error of [
      ydbErr(Code.BAD_REQUEST),
      ydbErr(Code.SCHEME_ERROR),
      new Error('app'),
    ]) {
      const fn = jest.fn(() => Promise.reject(error));
      await expect(runWithRetry(fn, { sleep })).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(delays).toEqual([]);
  });

  it('exhausted attempts propagates the LAST error as-is', async () => {
    const { sleep } = recordingSleep();
    // All three errors are transient — otherwise the policy would stop
    // earlier on a fatal one.
    const errors = [
      ydbErr(Code.OVERLOADED),
      ydbErr(Code.UNAVAILABLE),
      ydbErr(Code.ABORTED),
    ];
    let calls = 0;
    const fn = jest.fn(() => Promise.reject(errors[calls++]));

    await expect(runWithRetry(fn, { maxAttempts: 3, sleep })).rejects.toBe(
      errors[2],
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('maxAttempts: 1 — one attempt without delays even for transient error', async () => {
    const { sleep, delays } = recordingSleep();
    const boom = ydbErr(Code.UNAVAILABLE);
    const fn = jest.fn(() => Promise.reject(boom));

    await expect(runWithRetry(fn, { maxAttempts: 1, sleep })).rejects.toBe(
      boom,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});

describe('runWithRetry(): deterministic backoff and hooks', () => {
  it('delay sequence: exponential with cap and jitter', async () => {
    const { sleep, delays } = recordingSleep();
    const boom = ydbErr(Code.ABORTED);
    const fn = jest.fn(() => Promise.reject(boom));

    await expect(
      runWithRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 250,
        jitterRatio: 0,
        rng: seqRng([0]),
        sleep,
      }),
    ).rejects.toBe(boom);

    // Attempts 1..4, retries after 1..3: 100 -> 200 -> 250(cap)
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([100, 200, 250]);
  });

  it('onRetry called before each retry with attempt context', async () => {
    const { sleep } = recordingSleep();
    const boom = ydbErr(Code.ABORTED);
    let calls = 0;
    const fn = jest.fn(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(boom) : Promise.resolve('done');
    });
    const onRetry = jest.fn<
      (ctx: { attempt: number; error: unknown; delayMs: number }) => void
    >(() => {});

    await expect(
      runWithRetry(fn, {
        baseDelayMs: 50,
        jitterRatio: 0,
        rng: seqRng([0]),
        sleep,
        onRetry,
      }),
    ).resolves.toBe('done');

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      error: boom,
      delayMs: 50,
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      error: boom,
      delayMs: 100,
    });
  });

  it('onRetry not called on fatal error or exhaustion', async () => {
    const { sleep } = recordingSleep();
    const fatal = new Error('deterministic');
    const onRetry = jest.fn<() => void>(() => {});

    await expect(
      runWithRetry(() => Promise.reject(fatal), { sleep, onRetry }),
    ).rejects.toBe(fatal);

    await expect(
      runWithRetry(() => Promise.reject(ydbErr(Code.ABORTED)), {
        sleep,
        onRetry,
        maxAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(YDBError);

    expect(onRetry).not.toHaveBeenCalled();
  });

  it('custom shouldRetry overrides default classification', async () => {
    const { sleep, delays } = recordingSleep();
    const appError = new Error('flaky infra wrapped as app error');
    let calls = 0;
    const fn = jest.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(appError) : Promise.resolve('ok');
    });

    await expect(
      runWithRetry(fn, {
        sleep,
        shouldRetry: (error: unknown) => error === appError,
      }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays.length).toBe(1);

    // And conversely: shouldRetry: () => false disables retries entirely.
    const boom = ydbErr(Code.ABORTED);
    const strictFn = jest.fn(() => Promise.reject(boom));
    await expect(
      runWithRetry(strictFn, { sleep, shouldRetry: () => false }),
    ).rejects.toBe(boom);
    expect(strictFn).toHaveBeenCalledTimes(1);
  });
});

describe('runWithRetry(): cancellation via AbortSignal', () => {
  it('already aborted signal — fn not called, rejection with reason', async () => {
    const controller = new AbortController();
    const cancelReason = new Error('cancelled-before-start');
    controller.abort(cancelReason);
    const fn = jest.fn(() => Promise.resolve('never'));

    await expect(runWithRetry(fn, { signal: controller.signal })).rejects.toBe(
      cancelReason,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('non-Error cancellation reason wrapped in Error with original in cause', async () => {
    const controller = new AbortController();
    controller.abort('cancelled-with-string');
    const fn = jest.fn(() => Promise.resolve('never'));

    const rejected = runWithRetry(fn, { signal: controller.signal });
    await expect(rejected).rejects.toBeInstanceOf(Error);
    await rejected.catch((error: Error & { cause?: unknown }) => {
      expect(error.message).toContain('cancelled-with-string');
      expect(error.cause).toBe('cancelled-with-string');
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancellation during backoff wait interrupts pending retry', async () => {
    const controller = new AbortController();
    const cancelReason = new Error('cancelled-mid-backoff');
    let sleepCalls = 0;
    const sleep: YdbRetrySleepFn = (_ms, signal) => {
      sleepCalls += 1;
      controller.abort(cancelReason);
      void signal;
      return Promise.reject(cancelReason);
    };
    const boom = ydbErr(Code.OVERLOADED);
    const fn = jest.fn(() => Promise.reject(boom));
    const onRetry = jest.fn<() => void>(() => {});

    await expect(
      runWithRetry(fn, { signal: controller.signal, sleep, onRetry }),
    ).rejects.toBe(cancelReason);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('cancellation between attempts prevents next attempt start', async () => {
    const controller = new AbortController();
    const cancelReason = new Error('stopped-after-first-failure');
    const { sleep } = recordingSleep();
    const boom = ydbErr(Code.ABORTED);
    let calls = 0;
    const fn = jest.fn(() => {
      calls += 1;
      if (calls === 1) {
        controller.abort(cancelReason);
        return Promise.reject(boom);
      }
      return Promise.resolve('no');
    });

    await expect(
      runWithRetry(fn, { signal: controller.signal, sleep }),
    ).rejects.toBe(cancelReason);
    expect(calls).toBe(1);
  });
});

describe('transaction integration: no attempt multiplication (#98 + #27)', () => {
  interface FakeTxCall {
    options: Record<string, unknown>;
  }

  /** Minimal fake DB executor with controllable execute() behavior. */
  function makeFakeDb(
    executeImpl: (
      fn: any,
      opts: any,
      trx: any,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    const transactions: FakeTxCall[] = [];
    const executor: any = jest.fn(() => ({
      parameter() {
        return this;
      },
      timeout() {
        return this;
      },
      signal() {
        return this;
      },
      cancel() {
        return this;
      },
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve([]).then(onFulfilled, onRejected);
      },
    }));
    executor.transaction = (options?: Record<string, unknown>) => {
      transactions.push({ options: options ?? {} });
      const trx: any = jest.fn(() => ({
        parameter() {
          return this;
        },
        timeout() {
          return this;
        },
        signal() {
          return this;
        },
        cancel() {
          return this;
        },
        then(
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve([]).then(onFulfilled, onRejected);
        },
      }));
      const controller = new AbortController();
      return {
        execute: (fn: any) =>
          executeImpl(fn, options ?? {}, trx, controller.signal),
      };
    };
    return { executor: executor as unknown as YdbExecutor, transactions };
  }

  async function makeManager(dbExecutor: YdbExecutor) {
    const mod = await import('../transaction/transaction.manager.js');
    return new mod.YdbTransactionManager(dbExecutor);
  }

  it('runInTransaction has NO hidden ORM retry: transient error surfaces immediately', async () => {
    const boom = ydbErr(Code.ABORTED);
    let bodyCalls = 0;
    const db = makeFakeDb((_fn, _opts, _trx, _signal) => {
      bodyCalls += 1;
      return Promise.reject(boom);
    });

    const manager = await makeManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x')),
    ).rejects.toBe(boom);
    // Exactly one attempt: retrying a transaction body is the SDK's job
    // (idempotent), not a hidden ORM policy.
    expect(bodyCalls).toBe(1);
    expect(db.transactions).toHaveLength(1);
  });

  it('explicit composition: runWithRetry ON TOP of idempotent transaction complements SDK retry', async () => {
    const boom = ydbErr(Code.UNAVAILABLE);
    let sdkAttempts = 0;

    // Imitate @ydbjs/query: the FIRST transaction body attempt fails with a
    // transient error, the SDK-idempotent retry (second attempt INSIDE
    // execute) succeeds — no transient error escapes to the surface.
    const db = makeFakeDb(
      async (fn: any, opts: any, trx: any, signal: AbortSignal) => {
        for (;;) {
          sdkAttempts += 1;
          try {
            if (sdkAttempts === 1 && opts.idempotent) throw boom;
            return await fn(trx, signal);
          } catch (error) {
            if (error === boom && sdkAttempts < 2) continue; // SDK retries itself
            throw error;
          }
        }
      },
    );

    const manager = await makeManager(db.executor);

    const outerFn = jest.fn(() =>
      manager.runInTransaction(() => Promise.resolve('inner'), {
        idempotent: true,
      }),
    );

    // The outer retry fires zero times: the transient error is absorbed by
    // the SDK-idempotent retry INSIDE, so the policy never sees it.
    await expect(runWithRetry(outerFn, { maxAttempts: 3 })).resolves.toBe(
      'inner',
    );
    expect(outerFn).toHaveBeenCalledTimes(1);
    expect(sdkAttempts).toBe(2);
    expect(db.transactions[0].options).toMatchObject({ idempotent: true });
  });

  it('fatal transaction error not retried by outer retry', async () => {
    const fatal = ydbErr(Code.BAD_REQUEST);
    const db = makeFakeDb(() => Promise.reject(fatal));
    const manager = await makeManager(db.executor);

    const outerFn = jest.fn(() =>
      manager.runInTransaction(() => Promise.resolve('x')),
    );
    await expect(runWithRetry(outerFn, { maxAttempts: 3 })).rejects.toBe(fatal);
    expect(outerFn).toHaveBeenCalledTimes(1);
  });
});
