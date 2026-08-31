import { CommitError, YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';

/**
 * ORM error-type retry policy (#27).
 *
 * The SDK (@ydbjs/query) ALREADY retries single queries and the transaction
 * body (see "Retry semantics" in the README): it has its own by-default
 * unlimited budget and its own error classification. This policy is therefore
 * an EXPLICIT utility without hidden global state: the user decides which
 * composite operations to wrap in runWithRetry(). Wrapping single queries and
 * runInTransaction() is not needed and is harmful — SDK and ORM attempts would
 * multiply.
 *
 * Error classification is based ONLY on structural features (the YDB status
 * code from @ydbjs/error), never on the message text.
 */

/**
 * YDB statuses the policy treats as transient (#27): only
 * ABORTED / UNAVAILABLE / OVERLOADED. Everything else — including statuses
 * the SDK considers conditionally-retryable (SESSION_EXPIRED, UNDETERMINED,
 * TIMEOUT) and session errors (BAD_SESSION, SESSION_BUSY) — is not retried
 * by the ORM policy: these are either deterministic errors or the SDK
 * internal retry's concern.
 */
export const TRANSIENT_YDB_STATUSES: ReadonlySet<number> = new Set([
  StatusIds_StatusCode.ABORTED,
  StatusIds_StatusCode.UNAVAILABLE,
  StatusIds_StatusCode.OVERLOADED,
] as const);

/** Result of error classification. */
export type YdbErrorKind = 'transient' | 'fatal';

/** Signature of the sleep function (injected in tests). */
export type YdbRetrySleepFn = (
  ms: number,
  signal?: AbortSignal,
) => Promise<void>;

/** Signature of the random number generator (0..1) used for jitter. */
export type YdbRetryRng = () => number;

/**
 * Attempt context passed to the onRetry hook: called before each retry
 * (after the delay has elapsed).
 */
export interface YdbRetryAttemptContext {
  /** Number of the FAILED attempt (1-based). */
  attempt: number;
  /** Error that caused the retry. */
  error: unknown;
  /** Delay before the retry, ms. */
  delayMs: number;
}

/**
 * Retry policy options (#27).
 *
 * All fields are optional; the defaults live in DEFAULT_YDB_RETRY_POLICY_OPTIONS.
 * Options are validated fail-fast: an invalid value is an immediate error,
 * not a silently ignored option.
 */
export interface YdbRetryPolicyOptions {
  /**
   * Maximum number of attempts INCLUDING the first (default 3). Integer >= 1.
   */
  maxAttempts?: number;
  /**
   * Base exponential-backoff delay, ms (default 100). Attempt N (1-based)
   * waits baseDelayMs * 2^(N-1), capped at maxDelayMs.
   */
  baseDelayMs?: number;
  /**
   * Upper delay bound, ms (default 5000). Bounded backoff: exponential
   * growth stops at this value.
   */
  maxDelayMs?: number;
  /**
   * Jitter share in [0, 1] (default 0.25): the final delay is uniformly
   * distributed in [(1 - ratio) * raw, raw], where raw is the delay before
   * jitter. 0 disables jitter; 1 is "full" jitter (from 0 to raw).
   */
  jitterRatio?: number;
  /**
   * Cancellation signal: aborts the current delay wait and forbids new
   * attempts. Cancellation does NOT turn into a retry — the operation
   * finishes with the cancellation reason (signal.reason).
   */
  signal?: AbortSignal;
  /**
   * Hook called before each retry (after the delay): logging, metrics. Hook
   * errors are not swallowed — they propagate as is.
   */
  onRetry?: (ctx: YdbRetryAttemptContext) => void;
  /**
   * Custom retryability predicate: replaces the default classification
   * (classifyYdbError). Extension point for non-standard error wrappers; the
   * default strictly retries only ABORTED/UNAVAILABLE/OVERLOADED.
   */
  shouldRetry?: (error: unknown) => boolean;
  /** Test seam: replaces the wait (default setTimeout+signal). */
  sleep?: YdbRetrySleepFn;
  /** Test seam: deterministic randomness source for jitter. */
  rng?: YdbRetryRng;
}

/** Default maximum number of attempts (including the first). */
export const RETRY_DEFAULT_MAX_ATTEMPTS = 3;
/** Default base backoff delay in milliseconds. */
export const RETRY_DEFAULT_BASE_DELAY_MS = 100;
/** Default upper backoff delay bound in milliseconds. */
export const RETRY_DEFAULT_MAX_DELAY_MS = 5_000;
/** Default jitter ratio. */
export const RETRY_DEFAULT_JITTER_RATIO = 0.25;

/** Policy default values (frozen). */
export const DEFAULT_YDB_RETRY_POLICY_OPTIONS: Readonly<
  Required<
    Pick<
      YdbRetryPolicyOptions,
      'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'jitterRatio'
    >
  >
> = Object.freeze({
  maxAttempts: RETRY_DEFAULT_MAX_ATTEMPTS,
  baseDelayMs: RETRY_DEFAULT_BASE_DELAY_MS,
  maxDelayMs: RETRY_DEFAULT_MAX_DELAY_MS,
  jitterRatio: RETRY_DEFAULT_JITTER_RATIO,
});

/**
 * Classifies an error by structural features (#27):
 *
 * - CommitError (a commit error from @ydbjs/query) — unwrapped into its cause;
 * - YDBError — transient only for codes ABORTED/UNAVAILABLE/OVERLOADED;
 * - anything else (including ordinary application/validation/schema Errors
 *   and AbortError/TimeoutError) — fatal, retry is forbidden.
 *
 * The message text is never analyzed.
 */
export function classifyYdbError(error: unknown): YdbErrorKind {
  if (error instanceof CommitError) {
    return classifyYdbError(error.cause);
  }
  if (error instanceof YDBError) {
    return TRANSIENT_YDB_STATUSES.has(error.code) ? 'transient' : 'fatal';
  }
  return 'fatal';
}

/** true if the error is transient under the default policy (#27). */
export function isTransientYdbError(error: unknown): boolean {
  return classifyYdbError(error) === 'transient';
}

/**
 * Policy input format for configuration (#27): `false`/`undefined` — disabled
 * (only the SDK retries), `true` — defaults, an object — custom policy.
 */
export type YdbRetryPolicyInput = boolean | YdbRetryPolicyOptions;

/** Policy with resolved defaults (the result of resolution). */
export interface YdbResolvedRetryPolicy extends Required<
  Pick<
    YdbRetryPolicyOptions,
    'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'jitterRatio'
  >
> {
  signal?: AbortSignal;
  onRetry?: (ctx: YdbRetryAttemptContext) => void;
  shouldRetry?: (error: unknown) => boolean;
  sleep: YdbRetrySleepFn;
  rng: YdbRetryRng;
}

/**
 * Resolves a policy input (`boolean | YdbRetryPolicyOptions`) into a full
 * configuration with defaults (#27). `undefined`/`false` → null (policy
 * disabled — only the SDK retries, #98 behavior unchanged).
 * Invalid options are a fail-fast error.
 */
export function resolveYdbRetryPolicy(
  input?: YdbRetryPolicyInput,
): YdbResolvedRetryPolicy | null {
  if (input === undefined || input === false) return null;
  const options = input === true ? {} : input;
  validateYdbRetryPolicyOptions(options);

  return {
    maxAttempts:
      options.maxAttempts ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.maxAttempts,
    baseDelayMs:
      options.baseDelayMs ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.baseDelayMs,
    maxDelayMs:
      options.maxDelayMs ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.maxDelayMs,
    jitterRatio:
      options.jitterRatio ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.jitterRatio,
    signal: options.signal,
    onRetry: options.onRetry,
    shouldRetry: options.shouldRetry,
    sleep: options.sleep ?? defaultSleep,
    rng: options.rng ?? Math.random,
  };
}

/**
 * Fail-fast validation of policy options: there are no unknown keys (the
 * structure is typed), value ranges are checked. An invalid value is an
 * immediate configuration error.
 */
export function validateYdbRetryPolicyOptions(
  options?: YdbRetryPolicyOptions,
): void {
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null) {
    throw new Error('Retry policy options must be an object if provided.');
  }

  const { maxAttempts, baseDelayMs, maxDelayMs, jitterRatio, signal } = options;

  if (
    maxAttempts !== undefined &&
    (!Number.isInteger(maxAttempts) || maxAttempts < 1)
  ) {
    throw new Error(
      'Retry policy options: "maxAttempts" must be an integer >= 1.',
    );
  }
  for (const [name, value] of [
    ['baseDelayMs', baseDelayMs],
    ['maxDelayMs', maxDelayMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(
        `Retry policy options: "${name}" must be a positive number of milliseconds.`,
      );
    }
  }
  if (
    jitterRatio !== undefined &&
    (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1)
  ) {
    throw new Error(
      'Retry policy options: "jitterRatio" must be a number between 0 and 1.',
    );
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error('Retry policy options: "signal" must be an AbortSignal.');
  }
  for (const [name, value] of [
    ['onRetry', options.onRetry],
    ['shouldRetry', options.shouldRetry],
    ['sleep', options.sleep],
    ['rng', options.rng],
  ] as const) {
    if (value !== undefined && typeof value !== 'function') {
      throw new Error(`Retry policy options: "${name}" must be a function.`);
    }
  }
}

/**
 * Pure function computing the delay before a retry (#27):
 *
 *   raw     = min(baseDelayMs * 2^(attempt-1), maxDelayMs)
 *   delayMs = round(raw * (1 - jitterRatio + jitterRatio * rng()))
 *
 * The result is always capped at maxDelayMs (bounded backoff), deterministic
 * given fixed options and rng. `attempt` is 1-based.
 */
export function computeRetryDelayMs(
  attempt: number,
  options?: Pick<
    YdbRetryPolicyOptions,
    'baseDelayMs' | 'maxDelayMs' | 'jitterRatio'
  >,
  rng: YdbRetryRng = Math.random,
): number {
  const base =
    options?.baseDelayMs ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.baseDelayMs;
  const max =
    options?.maxDelayMs ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.maxDelayMs;
  const ratio =
    options?.jitterRatio ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.jitterRatio;

  const raw = Math.min(base * 2 ** (attempt - 1), max);
  const factor = 1 - ratio + ratio * rng();
  return Math.round(raw * factor);
}

/**
 * Normalizes a cancellation reason to an Error: the abort() reason may be any
 * value (including a string or undefined) — non-Errors are wrapped, the
 * original value is kept in cause. String/numeric reasons also end up in the
 * message; arbitrary objects are not stringified (unsafe) — they are visible
 * only via cause.
 */
export function abortReasonToError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const detail =
    typeof reason === 'string'
      ? reason
      : typeof reason === 'number' ||
          typeof reason === 'boolean' ||
          typeof reason === 'bigint'
        ? String(reason)
        : '';
  return new Error(
    detail ? `Operation aborted: ${detail}` : 'Operation aborted',
    { cause: reason },
  );
}

/** Default delay: setTimeout, interruptible by an abort signal. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReasonToError(signal.reason));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(abortReasonToError(signal?.reason));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs fn under the error-type retry policy (#27).
 *
 * Semantics:
 * - at most `maxAttempts` attempts INCLUDING the first; between attempts —
 *   exponential backoff with jitter, capped at maxDelayMs;
 * - retried are ONLY transient errors (by default — status codes
 *   ABORTED/UNAVAILABLE/OVERLOADED, structural classification);
 *   deterministic/application errors propagate immediately;
 * - exhausting attempts rethrows the LAST error as is (without wrapping) —
 *   the YDBError structure is preserved for the caller;
 * - `signal` aborts the delay wait and forbids new attempts; the operation
 *   finishes with the cancellation reason: if signal.reason is not an Error,
 *   it is wrapped in an Error (the original value — in cause);
 * - the callback must be idempotent or retry-tolerant: on a retry the whole
 *   fn runs anew (the same requirement as for idempotent transactions #98);
 * - fn receives the policy's cancellation signal (to wire it into the signals
 *   of underlying operations — so the attempt's signal reaches the DB).
 *
 * Executor/transaction integration (#27): use withRetryPolicy() and the retry
 * option of runInTransaction() — they apply this policy to operations WITHOUT
 * duplicating the SDK internal retry (the deterministic layer priority is
 * described in the README "Error-type retry policy").
 */
export async function runWithRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options?: YdbRetryPolicyOptions,
): Promise<T> {
  validateYdbRetryPolicyOptions(options);

  const maxAttempts =
    options?.maxAttempts ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.maxAttempts;
  const sleep = options?.sleep ?? defaultSleep;
  const rng = options?.rng ?? Math.random;
  const signal = options?.signal;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw abortReasonToError(signal.reason);

    try {
      return await fn(signal);
    } catch (error) {
      const retryable = options?.shouldRetry
        ? options.shouldRetry(error)
        : isTransientYdbError(error);
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = computeRetryDelayMs(attempt, options, rng);
      await sleep(delayMs, signal);
      options?.onRetry?.({ attempt, error, delayMs });
    }
  }

  /* istanbul ignore next: the loop above always returns or throws */
  throw new Error('unreachable');
}
