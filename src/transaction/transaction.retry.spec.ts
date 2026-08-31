import 'reflect-metadata';
import { describe, it, expect } from '@jest/globals';
import { CommitError, YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode as Code } from '@ydbjs/api/operation';
import { YdbTransactionManager } from './transaction.manager.js';
import type { YdbExecutor, YdbTransactionHandle } from '../core/interfaces.js';
import type { YdbRetrySleepFn } from '../core/retry.js';

/**
 * Integration tests for the retry policy in runInTransaction() (#27):
 * the policy is really applied to transaction execution, attempts do NOT
 * multiply with the SDK's internal retry, deterministic layer priority
 * (policy set — the ORM owns retries; not set — the SDK).
 */

function ydbErr(code: number): YDBError {
  return new YDBError(code, []);
}

/** Statuses the SDK's inner predicate considers always-retryable. */
const SDK_ALWAYS_RETRYABLE = new Set([
  Code.ABORTED,
  Code.UNAVAILABLE,
  Code.OVERLOADED,
  Code.BAD_SESSION,
  Code.SESSION_BUSY,
]);

interface RecordedTx {
  options: Record<string, unknown>;
}

interface FakeDbResult {
  executor: YdbExecutor;
  transactions: RecordedTx[];
}

type BodyFn = (trx: YdbExecutor, signal?: AbortSignal) => Promise<unknown>;

/** Attempt outcome: success (ok) or an error (Error-compatible). */
interface ScriptedOutcome {
  ok?: unknown;
  error?: Error;
}

/**
 * Simplest fake DB: one body attempt per execute(), no internal retry (as if
 * the SDK did not have one). The user callback is not invoked: the error
 * source is fully determined by the script.
 */
function makeSimpleDb(
  bodyScript: (invocation: number) => ScriptedOutcome,
): FakeDbResult & { bodyInvocations: () => number } {
  const transactions: RecordedTx[] = [];
  let bodyCalls = 0;
  const executor = (() => ({})) as unknown as YdbExecutor;
  (executor as unknown as Record<string, unknown>).transaction = (
    options?: Record<string, unknown>,
  ): YdbTransactionHandle => {
    transactions.push({ options: options ?? {} });
    const execute = (_fn: BodyFn): Promise<unknown> => {
      bodyCalls += 1;
      const outcome = bodyScript(bodyCalls);
      if (outcome.error !== undefined) throw outcome.error;
      return Promise.resolve(outcome.ok);
    };
    return { execute } as unknown as YdbTransactionHandle;
  };
  return { executor, transactions, bodyInvocations: () => bodyCalls };
}

/**
 * Fake DB with an internal SDK retry loop (@ydbjs/query):
 * the body is re-invoked for always-retryable statuses,
 * budget unbounded; non-retryable errors are wrapped
 * in an Error('Transaction failed.', { cause }) — like the real SDK.
 */
function makeSdkLikeDb(): FakeDbResult & {
  bodyInvocations: () => number;
  executes: () => number;
} {
  const transactions: RecordedTx[] = [];
  let bodyCalls = 0;
  let executeCalls = 0;
  const trx: any = {};
  const executor = (() => ({})) as unknown as YdbExecutor;
  (executor as unknown as Record<string, unknown>).transaction = (
    options?: Record<string, unknown>,
  ): YdbTransactionHandle => {
    transactions.push({ options: options ?? {} });
    executeCalls += 1;
    const execute = (fn: BodyFn): Promise<unknown> => {
      bodyCalls += 1;
      return fn(trx as YdbExecutor, undefined).catch(
        (error: unknown): unknown => {
          const retryable =
            error instanceof YDBError && SDK_ALWAYS_RETRYABLE.has(error.code);
          if (!retryable) {
            throw new Error('Transaction failed.', { cause: error });
          }
          // SDK retries: a new "session", the same callback.
          return execute(fn);
        },
      );
    };
    return { execute } as unknown as YdbTransactionHandle;
  };
  return {
    executor,
    transactions,
    bodyInvocations: () => bodyCalls,
    executes: () => executeCalls,
  };
}

function recordingSleep(): { sleep: YdbRetrySleepFn; delays: number[] } {
  const delays: number[] = [];
  const sleep: YdbRetrySleepFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

describe('runInTransaction({ retry }): policy applied to the transaction (#27)', () => {
  it('transient errors retried: three transaction opens, policy delays', async () => {
    const { sleep, delays } = recordingSleep();
    const db = makeSimpleDb((n) =>
      n < 3 ? { error: ydbErr(Code.ABORTED) } : { ok: 'done' },
    );
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: { jitterRatio: 0, rng: () => 0, sleep },
      }),
    ).resolves.toBe('done');

    expect(db.transactions).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });

  it('transaction options (isolation/idempotent/signal) threaded through as before', async () => {
    const { sleep } = recordingSleep();
    const db = makeSimpleDb(() => ({ ok: 1 }));
    const manager = new YdbTransactionManager(db.executor);
    const controller = new AbortController();

    await manager.runInTransaction(() => Promise.resolve('x'), {
      isolation: 'snapshotReadWrite',
      idempotent: true,
      signal: controller.signal,
      retry: { sleep },
    });

    expect(db.transactions[0].options).toEqual({
      isolation: 'snapshotReadWrite',
      idempotent: true,
      signal: controller.signal,
    });
  });

  it('deterministic error — one attempt, original error as-is', async () => {
    const { sleep } = recordingSleep();
    const boom = ydbErr(Code.BAD_REQUEST);
    const db = makeSimpleDb(() => ({ error: boom }));
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: { sleep },
      }),
    ).rejects.toBe(boom);
    expect(db.bodyInvocations()).toBe(1);
  });

  it('CommitError with a transient cause is classified and retried', async () => {
    const { sleep } = recordingSleep();
    let executes = 0;
    const executor = (() => ({})) as unknown as YdbExecutor;
    (executor as unknown as Record<string, unknown>).transaction =
      (): YdbTransactionHandle => {
        const execute = (): Promise<unknown> => {
          executes += 1;
          if (executes === 1) {
            // Commit error: ABORTED status in the cause (as returned by the SDK).
            return Promise.reject(
              new CommitError(
                'Transaction commit failed.',
                ydbErr(Code.ABORTED),
              ),
            );
          }
          return Promise.resolve('committed');
        };
        return { execute } as unknown as YdbTransactionHandle;
      };

    const manager = new YdbTransactionManager(executor);
    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: { jitterRatio: 0, rng: () => 0, sleep },
      }),
    ).resolves.toBe('committed');
    expect(executes).toBe(2);
  });

  it('a fresh timeout window on each policy attempt', async () => {
    const { sleep } = recordingSleep();
    const seenSignals: Array<AbortSignal | undefined> = [];
    // SDK-like DB invokes the user callback (silenced by the policy).
    const db = makeSdkLikeDb();
    const manager = new YdbTransactionManager(db.executor);

    let attempts = 0;
    await manager.runInTransaction(
      (_trx, signal) => {
        attempts += 1;
        seenSignals.push(signal);
        if (attempts === 1) throw ydbErr(Code.UNAVAILABLE);
        return Promise.resolve('ok');
      },
      { timeout: 60_000, retry: { jitterRatio: 0, rng: () => 0, sleep } },
    );

    expect(seenSignals).toHaveLength(2);
    // Each attempt got a FRESH timeout window (a new signal instance):
    expect(seenSignals[0]).not.toBe(seenSignals[1]);
    expect(seenSignals[0]?.aborted).toBe(false);
    expect(seenSignals[1]?.aborted).toBe(false);
  });

  it('validation: retry incompatible with reuse, invalid form rejected', async () => {
    const db = makeSimpleDb(() => ({ ok: 1 }));
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: true,
        reuse: true,
      }),
    ).rejects.toThrow(/reuse/);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: 'nope' as never,
      }),
    ).rejects.toThrow(/retry/);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: { maxAttempts: 0 },
      }),
    ).rejects.toThrow(/maxAttempts/);
  });

  it('cancellation: an aborted policy signal forbids DB access', async () => {
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const db = makeSimpleDb(() => ({ ok: 1 }));
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: { sleep, signal: controller.signal },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(db.transactions).toHaveLength(0);
  });

  it('cancellation during backoff stops the transaction retry', async () => {
    const controller = new AbortController();
    const sleep: YdbRetrySleepFn = () => Promise.resolve();
    const db = makeSimpleDb((n) =>
      n === 1 ? { error: ydbErr(Code.OVERLOADED) } : { ok: 'late' },
    );
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: {
          maxAttempts: 5,
          jitterRatio: 0,
          rng: () => 0,
          sleep,
          signal: controller.signal,
          onRetry: () =>
            controller.abort(new Error('stop-after-first-tx-attempt')),
        },
      }),
    ).rejects.toMatchObject({ message: 'stop-after-first-tx-attempt' });
    expect(db.transactions).toHaveLength(1);
  });
});

describe('runInTransaction({ retry }): attempt multiplication excluded', () => {
  it('sdk inner loop silenced: exactly maxAttempts body executions', async () => {
    const { sleep } = recordingSleep();
    // The body ALWAYS fails — without silencing the SDK's unbounded inner loop
    // the operation would never finish; the test completing means the loop was
    // silenced.
    const alwaysAbort = ydbErr(Code.ABORTED);
    const db = makeSdkLikeDb();
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.reject(alwaysAbort), {
        idempotent: true,
        retry: { maxAttempts: 3, jitterRatio: 0, rng: () => 0, sleep },
      }),
    ).rejects.toBe(alwaysAbort);

    // Exactly one REAL body attempt per policy attempt (+ superseded
    // protective invocations that never reach the user callback):
    expect(db.executes()).toBe(3);
    // Real callback executions — exactly maxAttempts:
    expect(db.bodyInvocations()).toBe(6);
  });

  it('success after a transient failure: one body attempt per policy attempt', async () => {
    const { sleep } = recordingSleep();
    // The body fails transitively on the first call — the SDK's inner
    // predicate would retry, but the policy's protective limit hands control
    // to the ORM.
    const db = makeSdkLikeDb();
    const manager = new YdbTransactionManager(db.executor);

    let userCalls = 0;
    await expect(
      manager.runInTransaction(
        () => {
          userCalls += 1;
          return userCalls === 1
            ? Promise.reject(ydbErr(Code.ABORTED))
            : Promise.resolve('fine');
        },
        {
          idempotent: true,
          retry: { maxAttempts: 4, jitterRatio: 0, rng: () => 0, sleep },
        },
      ),
    ).resolves.toBe('fine');

    // Exactly two real user attempts (failure + success after a policy retry),
    // each in ITS OWN transaction: attempts did not multiply.
    expect(userCalls).toBe(2);
    expect(db.executes()).toBe(2);
  });
});

describe('the #98 contract remains unchanged (#27)', () => {
  it('without the retry option the transaction body runs exactly once', async () => {
    const db = makeSimpleDb((n) =>
      n === 1 ? { error: ydbErr(Code.ABORTED) } : { ok: 'nope' },
    );
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x')),
    ).rejects.toBeInstanceOf(YDBError);
    // Neither any hidden ORM retry nor any requirement of query markings:
    // only the SDK owns body retries (#98).
    expect(db.bodyInvocations()).toBe(1);
    expect(db.transactions).toHaveLength(1);
  });

  it('transaction retry retries the callback as a whole — no per-query markings needed', async () => {
    const { sleep } = recordingSleep();
    // No .idempotent() is called inside the body: the idempotency contract
    // applies to the CALLBACK as a whole (#98), not to individual queries.
    const db = makeSdkLikeDb();
    const manager = new YdbTransactionManager(db.executor);

    let userCalls = 0;
    await expect(
      manager.runInTransaction(
        () => {
          userCalls += 1;
          return userCalls === 1
            ? Promise.reject(ydbErr(Code.OVERLOADED))
            : Promise.resolve('replayed');
        },
        {
          idempotent: true,
          retry: { maxAttempts: 3, jitterRatio: 0, rng: () => 0, sleep },
        },
      ),
    ).resolves.toBe('replayed');
    expect(userCalls).toBe(2);
  });
});
