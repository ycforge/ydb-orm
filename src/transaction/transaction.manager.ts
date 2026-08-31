import { resolveYdbRetryPolicy, runWithRetry } from '../core/retry.js';
import type { YdbRetryPolicyInput } from '../core/retry.js';
import type {
  YdbExecutor,
  YdbIsolationLevel,
  YdbTransactionOptions,
  YdbTransactionsSettings,
} from '../core/interfaces.js';
import {
  createTransactionContext,
  ensureExecutorIdentity,
  getActiveTransaction,
  getTransactionId,
  resolveTransactionSettings,
  runWithTransactionContext,
  setExecutorIdentity,
} from './transaction-context.js';

/** Generates a unique transaction identifier. */
function generateTransactionId(): symbol {
  return Symbol('transaction');
}

/**
 * Options for runInTransaction() (#98).
 *
 * Inherits the YDB transaction execution options (isolation/signal/timeout/
 * idempotent) and adds context control:
 *
 * - reuse — on a nested call, reuse the already-active transaction instead of
 *   throwing. The transaction stays under the control of the outer call: the
 *   inner callback neither commits nor rolls it back on its own.
 * - ambient — force this transaction into the ambient context (operations
 *   without an explicit { trx } run inside it), even when ambient is disabled
 *   globally. It also works with a nested `{ reuse: true }`: a nested context
 *   is created carrying the outer call's transaction (commit/rollback still
 *   belong to the outer call). A value of false does NOT disable the global
 *   ambient — use the module settings for that.
 * - retry — the ORM retry policy by error kind (#27): `true` — defaults
 *   (maxAttempts: 3, bounded backoff + jitter), an object — a custom policy.
 *   When a policy is set, ownership of retrying the body PASSES from the SDK
 *   to the ORM: exactly one body attempt per policy attempt (the SDK's inner
 *   loop is silenced), so the callback runs at most maxAttempts times —
 *   attempts do not multiply. Without a policy the behavior is unchanged (#98):
 *   the SDK retries the body by its own rules (unbounded budget). The
 *   idempotency contract applies to the CALLBACK as a whole (#98): the SDK
 *   ignores .idempotent() markings on individual queries inside the body and
 *   they have no effect on a callback replay.
 */
export interface RunInTransactionOptions extends YdbTransactionOptions {
  reuse?: boolean;
  ambient?: boolean;
  retry?: YdbRetryPolicyInput;
}

/** Allowed isolation levels — for fail-fast option validation. */
const ISOLATION_LEVELS: readonly YdbIsolationLevel[] = [
  'serializableReadWrite',
  'snapshotReadOnly',
  'snapshotReadWrite',
];

/** Keys allowed in RunInTransactionOptions (typo protection). */
const ALLOWED_OPTION_KEYS = new Set([
  'isolation',
  'signal',
  'timeout',
  'idempotent',
  'reuse',
  'ambient',
  'retry',
]);

/**
 * Marker for "SDK inner retry superseded by the ORM policy" (#27): thrown by
 * the transaction body when the SDK tries to start an attempt beyond the
 * policy limit. To the SDK retry predicate this is guaranteed non-retryable,
 * so the SDK loop ends; the original error from the last attempt is
 * propagated outward.
 */
class SdkRetrySupersededError extends Error {
  constructor(readonly lastError: unknown) {
    super('SDK transaction retry superseded by the ORM retry policy (#27)');
    this.name = 'SdkRetrySupersededError';
  }
}

/** Depth of the cause-chain traversal when unwrapping a transaction error. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Unwraps the execute() error: the SDK wraps non-retryable transaction errors
 * in an Error('Transaction failed.', { cause }). If a superseded-retry marker
 * is found in the chain, the ORIGINAL error of the last attempt is propagated
 * outward (for policy classification); otherwise the error is returned as is.
 */
function unwrapTransactionError(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof SdkRetrySupersededError) {
      return (
        current.lastError ??
        new Error(
          'Previous transaction attempt failed (the failure occurred outside the ' +
            'transaction body, e.g. at commit); the original error is not available.',
        )
      );
    }
    const cause: unknown = (current as { cause?: unknown })?.cause;
    if (cause === undefined || cause === null) break;
    current = cause;
  }
  return error;
}

/**
 * Fail-fast validation of transaction options: an unknown key or an invalid
 * value raises a configuration error immediately rather than silently
 * ignoring the option.
 */
export function validateRunInTransactionOptions(
  options?: RunInTransactionOptions,
): void {
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null) {
    throw new Error(
      'runInTransaction(): options must be an object if provided.',
    );
  }

  const unknown = Object.keys(options).filter(
    (key) => !ALLOWED_OPTION_KEYS.has(key),
  );
  if (unknown.length) {
    throw new Error(
      `runInTransaction(): unknown option(s) "${unknown.join('", "')}". ` +
        `Supported: ${[...ALLOWED_OPTION_KEYS].join(', ')}.`,
    );
  }

  const { isolation, signal, timeout, idempotent, reuse, ambient } = options;

  if (isolation !== undefined && !ISOLATION_LEVELS.includes(isolation)) {
    throw new Error(
      `runInTransaction(): invalid isolation level "${String(isolation)}". ` +
        `Supported: ${ISOLATION_LEVELS.join(', ')}.`,
    );
  }

  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error('runInTransaction(): "signal" must be an AbortSignal.');
  }

  if (timeout !== undefined) {
    if (
      typeof timeout !== 'number' ||
      !Number.isFinite(timeout) ||
      timeout <= 0
    ) {
      throw new Error(
        'runInTransaction(): "timeout" must be a positive number of milliseconds.',
      );
    }
  }

  for (const [name, value] of [
    ['idempotent', idempotent],
    ['reuse', reuse],
    ['ambient', ambient],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`runInTransaction(): "${name}" must be a boolean.`);
    }
  }

  if (
    options.retry !== undefined &&
    typeof options.retry !== 'boolean' &&
    (typeof options.retry !== 'object' || options.retry === null)
  ) {
    throw new Error(
      'runInTransaction(): "retry" must be a boolean or a retry policy object.',
    );
  }

  if (reuse && (isolation || signal || timeout !== undefined || idempotent)) {
    throw new Error(
      'runInTransaction(): "reuse: true" joins the already-active transaction — ' +
        'isolation/signal/timeout/idempotent cannot be changed mid-flight. ' +
        'Pass them only to the outermost call.',
    );
  }

  // A policy is meaningless with reuse: the outer call owns retries.
  if (reuse && options.retry !== undefined) {
    throw new Error(
      'runInTransaction(): "retry" cannot be combined with "reuse: true" — ' +
        'the outermost call owns transaction retries.',
    );
  }
}

/**
 * Transaction manager (#98).
 *
 * Default retry semantics match @ydbjs/query: with `idempotent: true` the SDK
 * may RE-EXECUTE the whole callback on retryable errors (session death, network
 * failures). This means the callback's side effects and all entity lifecycle
 * hooks may run more than once — the callback must be idempotent or tolerant of
 * replay.
 *
 * Retry-layer priority (#27, deterministic):
 * - no `retry` option — only the SDK owns body retries (as in #98);
 * - `retry` set (`true` or a policy object) — ownership passes to the ORM
 *   policy: exactly one body attempt per policy attempt (the SDK's inner loop
 *   is silenced), the callback runs at most maxAttempts times, bounded backoff
 *   + jitter between attempts, and only ABORTED/UNAVAILABLE/OVERLOADED statuses
 *   are retried. The callback idempotency requirement is the same as for the
 *   #98 idempotent transactions.
 * There is no layer mixing: attempts never multiply in any configuration.
 */
export class YdbTransactionManager {
  /**
   * @param db the DB executor.
   * @param settings transaction settings of the owning configuration (#199);
   *   if not provided, the process-global settings
   *   (configureTransactionContext) are used — the previous behavior.
   */
  constructor(
    private readonly db: YdbExecutor,
    private readonly settings?: YdbTransactionsSettings,
  ) {
    // Stable identity for a logical DB executor (#207): different wrappers of
    // the same executor share it, so nested-transaction detection compares
    // contexts by value rather than by object reference.
    ensureExecutorIdentity(db);
  }

  /**
   * Executes fn inside a YDB transaction.
   *
   * Nested calls are forbidden by default: if runInTransaction() is called
   * while another transaction of the same DB executor is active, an error is
   * thrown — silently opening an independent transaction on another session is
   * not allowed. To join the active transaction (commit/rollback owned by the
   * outer call), pass `{ reuse: true }`. Nesting on a DIFFERENT DB executor is
   * not an error: those are independent databases/sessions.
   *
   * @param fn callback receiving the transaction executor and the cancellation
   *   signal of the current attempt. On idempotent-retry it is invoked again —
   *   see above.
   * @param options see RunInTransactionOptions. Cancellation semantics:
   *   `signal` is global (cancels all attempts), `timeout` is per attempt
   *   (each retry gets a fresh window; the full deadline is
   *   `signal: AbortSignal.timeout(ms)`).
   */
  async runInTransaction<T>(
    fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
    options?: RunInTransactionOptions,
  ): Promise<T> {
    validateRunInTransactionOptions(options);

    // Nesting detection always works (whether or not ambient is enabled).
    const active = getActiveTransaction();
    // Compare by identity token, not by executor reference (#207).
    // active.db === this.db is a reference comparison; different wrappers of
    // one logical DB executor (logging/retry) share the token, so the
    // by-value check recognizes a nested transaction of the same DB.
    if (active && getTransactionId(active.db) === getTransactionId(this.db)) {
      if (options?.reuse) {
        // Reuse the active transaction: commit/rollback stay with the outer
        // call and a new DB transaction is not opened. If the inner call
        // explicitly sets ambient: true, create a nested ALS context with the
        // SAME trx/db/signal but the call's ambient flag: otherwise a
        // per-call ambient: true would be ignored when the outer transaction
        // was opened with ambient: false.
        if (options.ambient === true) {
          return runWithTransactionContext(
            createTransactionContext({
              transactionId: active.transactionId,
              trx: active.trx,
              db: this.db,
              signal: active.signal,
              ambient: true,
            }),
            () => fn(active.trx, active.signal),
          );
        }
        return fn(active.trx, active.signal);
      }
      throw new Error(
        'Nested runInTransaction() detected: a transaction is already active in ' +
          'this async context. Opening an independent transaction on another session ' +
          'is not allowed. Pass { reuse: true } to join the active transaction.',
      );
    }

    // Ambient auto-join for operations WITHOUT an explicit { trx }: opt-in
    // per call, the owning configuration's settings (#199), or the process
    // global settings (configureTransactionContext) — in priority order.
    const settings = resolveTransactionSettings(
      this.settings
        ? {
            ambient: this.settings.ambient ?? false,
            warnOutsideTransaction:
              this.settings.warnOutsideTransaction ?? false,
          }
        : undefined,
    );
    const ambient = options?.ambient ?? settings.ambient;

    // Timeout semantics (#98): a timeout applies TO EACH ATTEMPT.
    // On idempotent-retry the SDK re-executes the callback with a new session —
    // each attempt gets a FRESH timeout window instead of the first attempt's
    // expired deadline. The user signal, meanwhile, is GLOBAL: it is passed to
    // the SDK as is and cancels the whole operation (all attempts). A full
    // shared deadline is set explicitly: signal: AbortSignal.timeout(ms).

    const trxOptions = {
      isolation: options?.isolation,
      idempotent: options?.idempotent,
      // Only the user signal: a timeout must not reach here, otherwise it
      // would become a shared deadline for all attempts.
      signal: options?.signal,
    };

    /** Signal for a specific attempt: the SDK signal + a fresh AbortSignal.timeout. */
    const composeAttemptSignal = (sdkSignal?: AbortSignal) => {
      if (options?.timeout === undefined) return sdkSignal;
      const signals = [sdkSignal, AbortSignal.timeout(options.timeout)].filter(
        (s): s is AbortSignal => s instanceof AbortSignal,
      );
      return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    };

    /**
     * The execute() body: creates the attempt context and invokes the callback.
     * Used both by the legacy path and under a policy (#27).
     */
    const runAttemptBody = (
      trx: YdbExecutor,
      sdkSignal: AbortSignal | undefined,
    ) => {
      const attemptSignal = composeAttemptSignal(sdkSignal);
      // Generate a unique ID for this transaction and remember it on this
      // attempt's trx executor in the private identity registry (#217).
      const transactionId = generateTransactionId();
      // trx is always an object/function (a WeakMap key); guard for primitive mocks.
      if (trx && (typeof trx === 'object' || typeof trx === 'function')) {
        setExecutorIdentity(trx, transactionId);
      }
      return runWithTransactionContext(
        createTransactionContext({
          transactionId,
          trx,
          db: this.db,
          signal: attemptSignal,
          ambient,
        }),
        () => fn(trx, attemptSignal),
      );
    };

    // Retry policy (#27): without it — the previous behavior (#98), the SDK
    // alone retries the body by its own rules. With it — retry ownership passes
    // to the ORM: exactly one body attempt per policy attempt (the SDK's inner
    // loop is silenced via the SdkRetrySupersededError marker — which is
    // guaranteed non-retryable for its predicate), so attempts do not multiply
    // and the callback runs at most maxAttempts times.
    const policy = resolveYdbRetryPolicy(options?.retry);
    if (!policy) {
      return this.db
        .transaction(trxOptions)
        .execute((trx, sdkSignal) => runAttemptBody(trx, sdkSignal));
    }

    return runWithRetry(() => {
      let sdkAttempt = 0;
      let lastFailure: unknown;

      return this.db
        .transaction(trxOptions)
        .execute(async (trx, sdkSignal) => {
          sdkAttempt += 1;
          if (sdkAttempt > 1) {
            throw new SdkRetrySupersededError(lastFailure);
          }
          try {
            return await runAttemptBody(trx, sdkSignal);
          } catch (error) {
            lastFailure = error;
            throw error;
          }
        })
        .catch((error: unknown) => {
          throw unwrapTransactionError(error);
        });
    }, policy);
  }
}
