import type {
  YdbExecutor,
  YdbQuery,
  YdbTransactionOptions,
} from './interfaces.js';
import {
  abortReasonToError,
  resolveYdbRetryPolicy,
  runWithRetry,
} from './retry.js';
import type {
  YdbResolvedRetryPolicy,
  YdbRetryPolicyInput,
  YdbRetryPolicyOptions,
} from './retry.js';
import {
  ensureExecutorIdentity,
  inheritExecutorIdentity,
} from '../transaction/transaction-context.js';

/**
 * Wire-up of the retry policy to the executor (#27).
 *
 * Deterministic retry layering:
 * - policy disabled — single queries are retried only by the SDK inner loop
 *   (@ydbjs/query), as in #98;
 * - policy enabled — retry ownership PASSES to the ORM: each policy attempt
 *   accounts for exactly one SDK attempt. The SDK inner loop is suppressed
 *   via the query's `retry` event: the ORM aborts the attempt signal, the SDK
 *   does not run the next attempt, and the original error is taken from the
 *   event context and classified by the policy. The maximum number of DB
 *   calls equals maxAttempts — attempts do not multiply.
 */

/** AbortError-like error (cancellation), as opposed to application errors. */
function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Combines abort signals (undefined values are dropped). */
function combineSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const list = signals.filter(
    (s): s is AbortSignal => s instanceof AbortSignal,
  );
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : AbortSignal.any(list);
}

function policyToOptions(
  policy: YdbResolvedRetryPolicy,
): YdbRetryPolicyOptions {
  return {
    maxAttempts: policy.maxAttempts,
    baseDelayMs: policy.baseDelayMs,
    maxDelayMs: policy.maxDelayMs,
    jitterRatio: policy.jitterRatio,
    signal: policy.signal,
    onRetry: policy.onRetry,
    shouldRetry: policy.shouldRetry,
    sleep: policy.sleep,
    rng: policy.rng,
  };
}

/**
 * Creates a policy-backed query proxy: builder operations are remembered and
 * replayed on EVERY policy attempt (an SDK query instance caches its
 * execution result — it cannot be reused).
 *
 * The proxy owns ONE shared execution of the operation (#172): the first
 * `.then()`/await creates the execution promise and caches it; subsequent
 * subscriptions of the same query attach to the same promise and do not call
 * `makeBase()` again. This also applies to unmarked (fail-safe) queries —
 * two awaits do not duplicate the DB call.
 *
 * Cancellation (.cancel()) is also at the proxy level (#172): a shared
 * AbortController is combined into the operation signal (together with the
 * user's and the policy's) and is used BOTH for SDK attempts AND for the
 * policy backoff. Therefore cancel() fully stops the operation: it aborts an
 * in-flight attempt, interrupts the delay wait and forbids new attempts.
 *
 * Safety rule (#27): only a query explicitly marked idempotent
 * (`.idempotent(true)` / `{ idempotent: true }`) may be retried. An unmarked
 * query runs EXACTLY ONCE even with the policy enabled: its SDK inner loop is
 * also suppressed so an ambiguous transport failure cannot duplicate a write.
 * The marker is forwarded to the SDK query as `.idempotent(true)`.
 */
function createPolicyQuery(
  makeBase: () => YdbQuery,
  policy: YdbResolvedRetryPolicy,
): YdbQuery {
  const params: Array<[string, unknown]> = [];
  let timeoutMs: number | undefined;
  let userSignal: AbortSignal | undefined;
  // undefined = the user did not call .idempotent() — we treat the query as
  // NON-idempotent (fail-safe); true = marked; false = explicitly unmarked.
  let markedIdempotent: boolean | undefined;
  let current: YdbQuery | undefined;

  // Shared proxy cancellation signal (#172): cancel() aborts it — it cancels
  // the in-flight SDK attempt (the signal reaches the query via
  // combineSignals), the policy backoff (signal in runWithRetry), and
  // forbids new attempts.
  const controller = new AbortController();
  const cancelError: Error = new Error('The operation was aborted');
  cancelError.name = 'AbortError';

  // Single execution of the operation for the whole proxy query (#172):
  // two .then()/awaits on one query do not duplicate the DB call.
  let settled: Promise<unknown> | undefined;
  // Flag: execution has started (the first .then()/await).
  // After that the mutating builder methods are forbidden.
  let started = false;

  const runOnce = async (policySignal?: AbortSignal): Promise<unknown> => {
    // Cancellation before start (cancel() before the first await) — no DB
    // call at all (#172); for marked queries it duplicates the runWithRetry
    // check.
    if (policySignal?.aborted) throw abortReasonToError(policySignal.reason);

    const query = makeBase();
    current = query;
    for (const [name, value] of params) query.parameter(name, value);
    if (timeoutMs !== undefined) query.timeout(timeoutMs);
    if (markedIdempotent === true) query.idempotent?.(true);

    // Suppress the SDK inner retry: after its first failure the SDK wants to
    // retry (the 'retry' event fires after its own delay) — we abort the
    // attempt signal, the SDK throws AbortError BEFORE the next DB call, and
    // we replace it with the original error from the event context. For
    // unmarked queries this guarantees strictly-once execution.
    const attemptController = new AbortController();
    let captured = false;
    let capturedError: unknown;
    query.on?.('retry', (ctx) => {
      if (!captured) {
        captured = true;
        capturedError = ctx.error;
      }
      attemptController.abort();
    });

    const combined = combineSignals([policySignal, attemptController.signal]);
    if (combined) query.signal(combined);

    try {
      return await query;
    } catch (error) {
      if (captured && isAbortLike(error)) throw capturedError;
      throw error;
    }
  };

  const proxy: YdbQuery = {
    parameter(name: string, value: unknown): YdbQuery {
      if (started) {
        throw new Error(
          'Cannot call .parameter() after query execution has started. ' +
            'All query parameters must be set before the first await/.then().',
        );
      }
      params.push([name, value]);
      return proxy;
    },
    timeout(timeout: number): YdbQuery {
      if (started) {
        throw new Error(
          'Cannot call .timeout() after query execution has started. ' +
            'Query timeout must be set before the first await/.then().',
        );
      }
      timeoutMs = timeout;
      return proxy;
    },
    signal(signal: AbortSignal): YdbQuery {
      if (started) {
        throw new Error(
          'Cannot call .signal() after query execution has started. ' +
            'AbortSignal must be set before the first await/.then().',
        );
      }
      userSignal = signal;
      return proxy;
    },
    idempotent(flag?: boolean): YdbQuery {
      if (started) {
        throw new Error(
          'Cannot call .idempotent() after query execution has started. ' +
            'Idempotency flag must be set before the first await/.then().',
        );
      }
      markedIdempotent = flag !== false;
      return proxy;
    },
    cancel(): YdbQuery {
      // Cancel the in-flight SDK attempt plus the whole operation lifecycle.
      current?.cancel();
      controller.abort(cancelError);
      return proxy;
    },
    then(onFulfilled?, onRejected?) {
      // The first subscriber creates and caches the shared operation execution
      // (#172); subsequent subscriptions attach to the same promise and do not
      // touch the DB again.
      if (settled === undefined) {
        started = true;
        const operationSignal = combineSignals([
          userSignal,
          policy.signal,
          controller.signal,
        ]);
        const options = {
          ...policyToOptions(policy),
          signal: operationSignal,
        };

        // Fail-safe (#27): without an explicit idempotency marker the policy
        // is NOT applied — exactly one DB attempt.
        settled =
          markedIdempotent === true
            ? runWithRetry(runOnce, options)
            : Promise.resolve().then(() => runOnce(operationSignal));
        // A cached rejection must not become an unhandled rejection while the
        // operation has no subscribers (#172).
        settled.catch(() => {});
      }
      return settled.then(onFulfilled, onRejected);
    },
  };
  return proxy;
}

/**
 * Attaches the retry policy (#27) to an executor: every query through the
 * returned executor runs under the policy (classification by statuses
 * ABORTED/UNAVAILABLE/OVERLOADED, bounded backoff + jitter, signal-based
 * cancellation). `transaction()` is passed through as is — retries of the
 * transaction body are governed by the `retry` option in runInTransaction().
 *
 * IDEMPOTENCY RULE (#27, fail-safe): the policy retries only queries
 * EXPLICITLY marked idempotent — `.idempotent(true)` on the chain or
 * `{ idempotent: true }` in QueryOptions. An unmarked query (including any
 * INSERT/UPSERT/UPDATE/DELETE by default) runs EXACTLY ONCE even with the
 * policy enabled: its SDK inner loop is also suppressed, so an ambiguous
 * transport failure cannot duplicate a write. Only retry-tolerant operations
 * may be retried.
 *
 * A disabled policy (`false`/`undefined`) returns the executor unchanged —
 * behavior identical to #98.
 *
 * Wrap ONCE; nesting several policies would multiply attempts.
 */
export function withRetryPolicy(
  executor: YdbExecutor,
  policyInput?: YdbRetryPolicyInput,
): YdbExecutor {
  const policy = resolveYdbRetryPolicy(policyInput);
  if (!policy) return executor;

  const base = executor as unknown as (
    strings: TemplateStringsArray,
    ...args: unknown[]
  ) => YdbQuery;
  const wrapped = ((
    strings: TemplateStringsArray,
    ...args: unknown[]
  ): YdbQuery =>
    createPolicyQuery(
      () => base(strings, ...args),
      policy,
    )) as unknown as YdbExecutor;

  (wrapped as unknown as Record<string, unknown>).transaction = (
    options?: YdbTransactionOptions,
  ) => executor.transaction(options);

  // Identity (#207): the wrapper inherits the identity token of its source
  // (see also wrapExecutorWithLogging), so different wrappers of one logical
  // executor are recognized as one DB context.
  ensureExecutorIdentity(executor);
  inheritExecutorIdentity(executor, wrapped);

  return wrapped;
}
