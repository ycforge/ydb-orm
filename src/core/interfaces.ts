import { Driver, DriverOptions } from '@ydbjs/core';
import type { CredentialsProvider } from '@ydbjs/auth';
import type { AuthManager } from '@ycforge/auth';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { AadFormat } from '../encryption/aad.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import type { QueryLogger, YdbLogParamValues } from './query-logger.js';
import type { YdbRetryPolicyInput } from './retry.js';

export type { QueryOptions } from './query-options.js';
export type { QueryLogger, QueryLogEntry } from './query-logger.js';

/**
 * Configuration options for the YDB ORM module (used by
 * YdbCoreModule.forRootAsync() and createDriver()).
 *
 * @see createDriver
 * @see resolveCredentialsProvider
 * @see withRetryPolicy
 * @see wrapExecutorWithLogging
 */
export interface YdbModuleOptions {
  endpoint: string;
  /**
   * A ready-made CredentialsProvider (#96) — the useExisting pattern: passed
   * through as is (an OAuth token, test implementations, reusing a provider
   * from another module).
   *
   * Deterministic provider-source priority (see resolveCredentialsProvider):
   *   credentialsProvider → auth (AuthManager from @ycforge/auth) →
   *   DI provider YDB_CREDENTIALS_PROVIDER →
   *   driverOptions.credentialsProvider.
   * Setting both credentialsProvider and
   * driverOptions.credentialsProvider is a configuration error: silently
   * picking one of them is not allowed.
   */
  credentialsProvider?: CredentialsProvider;
  /**
   * A ready-made AuthManager from the `@ycforge/auth` package — the single
   * entry point for authentication strategies (iam_token / metadata /
   * auth_key / access_token / anonymous / static). Adapted to a
   * CredentialsProvider via `createYdbCredentialsProvider(auth, YDB_AUTH_USAGE,
   * options)` from `@ycforge/auth/ydb`.
   *
   * Priority: immediately after the explicit `credentialsProvider` and before
   * the DI provider `YDB_CREDENTIALS_PROVIDER` /
   * `driverOptions.credentialsProvider`.
   * Setting both `auth` and `driverOptions.credentialsProvider` is a
   * configuration error (`Conflicting YDB credentials configuration`).
   */
  auth?: AuthManager;
  /**
   * Custom driver factory: if set, used instead of building the Driver from
   * endpoint/driverOptions. Convenient for tests and non-standard transports.
   * The driver returned by the factory is considered owned by the module:
   * on graceful shutdown the module closes it via driver.close().
   */
  driverFactory?: () => Driver | Promise<Driver>;
  driverOptions?: DriverOptions;
  poolOptions?: {
    minSize?: number;
    maxSize?: number;
    sessionTimeout?: number;
  };
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  /**
   * Security AAD serialization format (#165): 'v2' (default) — canonical
   * self-delimiting serialization with no collisions from nested delimiters,
   * or 'legacy' — the historical `name=value;...` ONLY for the transition
   * period: changing the format changes the authenticated bytes, so old
   * ciphertext will not decrypt under v2. Migration: while the DB still holds
   * rows written in legacy, read/encrypt in 'legacy' and re-encrypt them
   * (save/script), then switch to 'v2'.
   */
  aadFormat?: AadFormat;
  /**
   * Automatic Security AAD format detection on decryption (#165):
   * true (default) — if the primary format fails to decrypt, the second one
   * is tried. This is the only safe upgrade path for an existing database:
   * rows written before `v2` existed remain readable after the default
   * changes. false — strict mode, viable only after all data has been
   * re-encrypted into a single format (a format failure fails immediately).
   * Fields with `aadOverride` do not depend on format fallbacks — no retry.
   */
  aadReadFallback?: boolean;
  /**
   * Entity validation provider invoked before writes (save/insert/insertMany/update).
   * For example, ClassValidatorProvider. Without it no validation runs.
   */
  validationProvider?: YdbValidationProvider;
  /**
   * Version of generated UUIDs for primary keys: v7 (default, time-sortable)
   * or v4 (random, for the transition period).
   */
  uuidVersion?: 'v4' | 'v7';
  /**
   * Like TypeORM synchronize: on application startup align the DB schema
   * with the metadata of all entities (create missing tables and columns).
   * Dev-only — use migrations in production.
   */
  sync?: boolean;
  /**
   * Query logging: true (default console) or a QueryLogger instance.
   * Logs SQL, parameter names, safe value metadata (type and size class; raw
   * is hidden by default) and duration.
   */
  logQueries?: boolean | QueryLogger;
  /**
   * Raw parameter value disclosure in logs (#168). By default
   * (undefined/false) values are not logged at all — only safe metadata
   * (type and a coarse size class, e.g. `<string:1-31>` or `<bytes:128-511>`;
   * the exact length is hidden), so sensitive data with arbitrary names never
   * reaches the logs.
   * "Values hidden by default" is an intentional behavior change since 1.0.
   * Raw disclosure is an explicit opt-in: true (all values), string[] /
   * RegExp / predicate (only matching parameter names). Binary values are
   * always masked, even with `true`.
   */
  logParamValues?: YdbLogParamValues;
  /**
   * Transaction settings (#98):
   * - ambient — enable the ambient transaction context (AsyncLocalStorage):
   *   repository operations inside runInTransaction() without an explicit
   *   { trx } automatically use the active transaction. Off by default.
   * - warnOutsideTransaction — warn when a query runs outside any
   *   transaction. The warning goes to the logger (#206): to
   *   `QueryLogger.warn` (the `logQueries` option) or to the console
   *   fallback `ConsoleQueryLogger` if no custom logger is configured. Off
   *   by default (to avoid noise); enable deliberately, e.g. in dev.
   */
  transactions?: YdbTransactionsSettings;
  /**
   * Error-type retry policy (#27) for executor operations.
   *
   * - `undefined` / `false` (default) — policy disabled: retries of single
   *   queries are handled only by the SDK internal retry (as in #98);
   * - `true` — policy with defaults (maxAttempts: 3, bounded backoff
   *   100..5000 ms, jitter 0.25);
   * - a `YdbRetryPolicyOptions` object — custom policy.
   *
   * IDEMPOTENCY RULE (fail-safe): the policy retries only queries explicitly
   * marked idempotent — `.idempotent(true)` on the chain or
   * `{ idempotent: true }` in QueryOptions. An unmarked query (including all
   * writes by default) runs exactly once: the SDK inner loop is suppressed,
   * so an ambiguous transport failure cannot duplicate a write. For
   * transactions there is a separate retry option in runInTransaction() (the
   * callback must be idempotent, #98).
   * When the policy is enabled and the query is marked, the ORM owns retries
   * through this executor and SUPPRESSES the SDK inner loop (one SDK attempt
   * per ORM attempt) — attempts do not multiply. Retry statuses: only
   * ABORTED/UNAVAILABLE/OVERLOADED. See README "Retry policy".
   */
  retry?: YdbRetryPolicyInput;
}

/**
 * Transaction-related settings of a configuration (#98): `ambient` enables
 * the ambient transaction context, `warnOutsideTransaction` warns about
 * queries running outside any transaction. Both are off by default.
 */
export interface YdbTransactionsSettings {
  ambient?: boolean;
  warnOutsideTransaction?: boolean;
}

/**
 * A builder-style YDB query that is thenable (awaitable). Mirrors the subset
 * of the @ydbjs/query client API used by the ORM.
 */
export interface YdbQuery {
  parameter(name: string, value: unknown): YdbQuery;
  timeout(timeout: number): YdbQuery;
  signal(signal: AbortSignal): YdbQuery;
  /**
   * Idempotency marker for a single query (#27): allows the ORM retry policy
   * (and the SDK's conditionally-retryable statuses) to retry this query.
   * By default queries are NOT considered idempotent: without the marker the
   * ORM policy runs the query exactly once.
   */
  idempotent(flag?: boolean): YdbQuery;
  cancel(): YdbQuery;
  /**
   * SDK query events (#27): the real Query from @ydbjs/query exposes
   * `.on('retry', ctx)` — the ORM policy uses it to suppress the SDK inner
   * retry and take retry ownership itself. Optional: mocks and other
   * implementations may omit it.
   */
  on?(
    event: 'retry',
    listener: (ctx: { attempt: number; error: unknown }) => void,
  ): unknown;
  then: Promise<any>['then'];
}

/**
 * YDB transaction isolation level (see TransactionExecuteOptions in @ydbjs/query).
 */
export type YdbIsolationLevel =
  'serializableReadWrite' | 'snapshotReadOnly' | 'snapshotReadWrite';

/**
 * Transaction execution options (#98).
 *
 * - isolation — YDB isolation level (defaults to 'serializableReadWrite' on
 *   the SDK side);
 * - signal — GLOBAL AbortSignal: aborts the whole operation, all attempts
 *   (including idempotent-retry); passed through to the SDK as is;
 * - timeout — timeout in milliseconds applied PER ATTEMPT: on idempotent-retry
 *   each attempt gets a FRESH timeout window, not the expired deadline of the
 *   first attempt. A full deadline for the whole operation is set explicitly:
 *   signal: AbortSignal.timeout(ms);
 * - idempotent — allow the SDK to retry the transaction body on retryable
 *   errors. WARNING: on a retry the whole callback executes anew, so side
 *   effects and lifecycle hooks may fire more than once.
 */
export interface YdbTransactionOptions {
  isolation?: YdbIsolationLevel;
  signal?: AbortSignal;
  timeout?: number;
  idempotent?: boolean;
}

/** Handle of an open (or opening) transaction. */
export interface YdbTransactionHandle {
  execute<T>(
    fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

/**
 * YDB query executor: callable as a tagged-template query builder,
 * exposing `transaction()` to execute inside a transaction.
 */
export interface YdbExecutor {
  (strings: TemplateStringsArray, ...args: any[]): YdbQuery;
  transaction(options?: YdbTransactionOptions): YdbTransactionHandle;
}
