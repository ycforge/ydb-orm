import { AsyncLocalStorage } from 'node:async_hooks';
import type { YdbExecutor } from '../core/interfaces.js';
import type { YdbTransactionsSettings } from '../core/interfaces.js';
import type { QueryLogger } from '../core/query-logger.js';

/** Parameters for creating an active-transaction context (#208). */
export interface TransactionContextParams {
  transactionId: symbol;
  trx: YdbExecutor;
  db: YdbExecutor;
  signal?: AbortSignal;
  ambient: boolean;
}

/**
 * The active transaction in an async-call chain (#98).
 *
 * It is stored in AsyncLocalStorage and used for two independent tasks:
 * 1. Detection of nested runInTransaction() — always works, regardless of
 *    settings (otherwise a nested call would silently open a separate
 *    transaction on another session).
 * 2. Ambient auto-join: when enabled (globally through the module settings or
 *    locally through the `ambient` call option), repository operations without
 *    an explicit { trx } run inside the active transaction.
 *
 * Transaction identity is determined by `transactionId`, not by an executor
 * reference, because different wrappers may represent one logical transaction
 * (for example, when an executor is wrapped for logging).
 *
 * Invariants (#208) are validated at the single creation point — the
 * constructor — so an invalid instance cannot be created either through the
 * createTransactionContext() factory or directly via new. A private brand
 * field makes the context opaque to structural typing and protects
 * runWithTransactionContext() against forgeries via cast/instanceof.
 */
export class ActiveTransactionContext {
  /** Unique transaction identifier (a symbol) — for by-value comparison. */
  readonly transactionId: symbol;
  /** Transaction executor — passed into operations instead of the entity executor. */
  readonly trx: YdbExecutor;
  /** The DB executor that opened the transaction: nesting is detected by transactionId. */
  readonly db: YdbExecutor;
  /** Cancellation signal for the specific transaction attempt (new on retry). */
  readonly signal: AbortSignal | undefined;
  /** Whether ambient auto-join is enabled for this context. */
  readonly ambient: boolean;
  /** Private brand mark: only present on instances created through the factory. */
  readonly #brand = Symbol('ActiveTransactionContext');

  constructor(params: TransactionContextParams) {
    validateTransactionContextParams(params);
    this.transactionId = params.transactionId;
    this.trx = params.trx;
    this.db = params.db;
    this.signal = params.signal;
    this.ambient = params.ambient;
  }

  /** Returns true only for a genuine factory-created instance. */
  static isContext(value: unknown): value is ActiveTransactionContext {
    return typeof value === 'object' && value !== null && #brand in value;
  }
}

const storage = new AsyncLocalStorage<ActiveTransactionContext>();

/** The process transaction settings (filled from YdbModuleOptions). */
let settings: Required<YdbTransactionsSettings> = {
  ambient: false,
  warnOutsideTransaction: false,
};

/**
 * Configures the transactional behavior of the process (#98).
 * Called by YdbOrmModule during initialization; also available to standalone
 * users. Settings are global for the process — like the entity registry.
 */
export function configureTransactionContext(
  options?: YdbTransactionsSettings,
): void {
  settings = {
    ambient: options?.ambient ?? false,
    warnOutsideTransaction: options?.warnOutsideTransaction ?? false,
  };
}

/** Current settings (for tests and the transaction manager). */
export function getTransactionContextSettings(): Required<YdbTransactionsSettings> {
  return { ...settings };
}

/**
 * Effective transaction settings for one operation (#199):
 * the owning entity configuration's settings, if provided, otherwise the
 * process-global ones (the previous single-configuration behavior).
 */
export function resolveTransactionSettings(
  scopeSettings?: Required<YdbTransactionsSettings>,
): Required<YdbTransactionsSettings> {
  return scopeSettings ?? settings;
}

/** The active transaction in the current async chain, if any. */
export function getActiveTransaction(): ActiveTransactionContext | undefined {
  return storage.getStore();
}

/**
 * Runs fn with the given active-transaction context.
 *
 * Public boundary (#208): the context must be a genuine instance created via
 * createTransactionContext() — the private brand check excludes plain objects
 * and forgeries via cast/instanceof alike.
 */
export function runWithTransactionContext<T>(
  context: ActiveTransactionContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (!ActiveTransactionContext.isContext(context)) {
    throw new Error(
      'ActiveTransactionContext: invalid context. Create it via createTransactionContext().',
    );
  }
  return storage.run(context, fn);
}

/**
 * Resolves the executor for a single repository operation (#98).
 *
 * - An explicit trx always wins, BUT under an active ambient context of a
 *   different transaction this is almost certainly an error — an active
 *   ambient transaction cannot be mixed with a foreign one, so we throw a
 *   clear error.
 * - Without an explicit trx, when ambient auto-join is enabled, the active
 *   transaction is returned.
 * - Otherwise — the entity's normal executor; if warnOutsideTransaction is
 *   configured and no transaction is active at all, a warning is emitted.
 *
 * The warning goes to the logger through the optional `warn` hook (#206).
 * The caller passes the logger of ITS own configuration (resolveExecutorLogger);
 * without a passed logger no warning is emitted at all — there is no direct
 * console.warn here.
 *
 * Errors are neither swallowed nor replaced with fallbacks.
 */
export function resolveOperationExecutor(
  explicitTrx: YdbExecutor | undefined,
  fallback: YdbExecutor | undefined,
  entityName: string,
  scopeSettings?: Required<YdbTransactionsSettings>,
  logger?: QueryLogger,
): YdbExecutor | undefined {
  const active = storage.getStore();
  const effectiveSettings = resolveTransactionSettings(scopeSettings);

  if (explicitTrx) {
    if (
      active?.ambient &&
      active.transactionId !== getTransactionId(explicitTrx)
    ) {
      throw new Error(
        `Transaction mixing detected in ${entityName}: an explicit { trx } was passed, ` +
          'but a different transaction is active in the current async context. ' +
          'Either drop the explicit { trx } to join the ambient transaction, or run this ' +
          'operation outside of it.',
      );
    }
    return explicitTrx;
  }

  if (active?.ambient) {
    return active.trx;
  }

  // No executor — the caller itself throws a clear "executor not set" error,
  // so no warning is needed here.
  if (!fallback) {
    return fallback;
  }

  if (effectiveSettings.warnOutsideTransaction && !active) {
    logger?.warn?.(
      `[ydb-orm] ${entityName}: query executed outside any transaction ` +
        '(warnOutsideTransaction is enabled).',
    );
  }

  return fallback;
}

/**
 * Private identity registry (#217): executor -> symbol.
 *
 * The source of truth for transaction/executor identity lives HERE, not in a
 * mutable property on the executor. Weak keys let objects with no remaining
 * references be collected (including the short-lived trx executors of each
 * attempt) and require NO mutation of the executor object at all — frozen/sealed
 * executors work unchanged. Consumers have no access to the registry, so they
 * cannot overwrite someone else's identity or stitch two independent contexts
 * into one.
 */
const identityRegistry = new WeakMap<YdbExecutor, symbol>();

/**
 * Gets the identity token from the executor (#207/#217).
 * Returns the symbol from the private registry (for a live transaction that is
 * its transactionId, for a logical DB executor — a stable identifier of that
 * executor); otherwise the executor itself for backwards compatibility
 * (by-reference comparison for executors without identity).
 */
export function getTransactionId(trx: YdbExecutor): symbol | YdbExecutor {
  return identityRegistry.get(trx) ?? trx;
}

/**
 * Explicitly records an identity token for an executor in the private registry
 * (#217). Used to assign a freshly created trx executor its attempt's
 * transactionId (see runAttemptBody, entity-relations). Does not mutate the
 * object.
 */
export function setExecutorIdentity(executor: YdbExecutor, id: symbol): void {
  identityRegistry.set(executor, id);
}

/**
 * Assigns the executor a stable identity token if it does not have one yet
 * (#207). Used for logical DB executors: different wrappers of one logical
 * executor share this token, so nested-transaction detection can compare DB
 * contexts by value rather than by object reference. The token is stored in
 * the private registry and does not mutate the executor.
 */
export function ensureExecutorIdentity(executor: YdbExecutor): symbol {
  const existing = identityRegistry.get(executor);
  if (existing) return existing;
  const id = Symbol('ydb.executor');
  identityRegistry.set(executor, id);
  return id;
}

/**
 * Inherits the identity token from an inner executor onto a wrapper (#207):
 * wrapExecutorWithLogging()/withRetryPolicy() create NEW objects, and so that
 * wrappers of the same logical executor are recognized as one DB context, they
 * copy the token from the source executor into the wrapper's private registry.
 */
export function inheritExecutorIdentity(
  source: YdbExecutor,
  target: YdbExecutor,
): void {
  const id = identityRegistry.get(source);
  if (id !== undefined) {
    identityRegistry.set(target, id);
  }
}

/**
 * Single point of validation for ActiveTransactionContext invariants (#208):
 *
 * - transactionId must be a symbol
 * - trx must be a valid executor (object or function)
 * - db must be a valid executor (object or function)
 * - signal, if provided, must be an AbortSignal
 * - ambient must be a boolean
 *
 * @throws Error if any invariant is violated
 */
function validateTransactionContextParams(
  params: TransactionContextParams,
): void {
  if (typeof params.transactionId !== 'symbol') {
    throw new Error(
      'ActiveTransactionContext: transactionId must be a symbol.',
    );
  }
  if (
    !params.trx ||
    (typeof params.trx !== 'object' && typeof params.trx !== 'function')
  ) {
    throw new Error(
      'ActiveTransactionContext: trx must be a valid executor (object or function).',
    );
  }
  if (
    !params.db ||
    (typeof params.db !== 'object' && typeof params.db !== 'function')
  ) {
    throw new Error(
      'ActiveTransactionContext: db must be a valid executor (object or function).',
    );
  }
  if (params.signal !== undefined && !(params.signal instanceof AbortSignal)) {
    throw new Error(
      'ActiveTransactionContext: signal must be an AbortSignal if provided.',
    );
  }
  if (typeof params.ambient !== 'boolean') {
    throw new Error('ActiveTransactionContext: ambient must be a boolean.');
  }
}

/**
 * Canonical way to obtain an ActiveTransactionContext: invariant validation
 * (#208) happens in the constructor, and the brand field blocks structural
 * forgeries (object literals and casts are rejected in
 * runWithTransactionContext).
 */
export function createTransactionContext(
  params: TransactionContextParams,
): ActiveTransactionContext {
  return new ActiveTransactionContext(params);
}
