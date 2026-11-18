import type { YdbExecutor } from './interfaces.js';

/**
 * Native (SDK-level) contract of an ACTIVE YDB transaction — the same shape
 * @ydbjs/topic's createTxWriter(tx, options)/createTxReader(tx, options)
 * expect (structural subset of the @ydbjs/query TX object). Obtained inside a
 * transaction via getNativeTransaction(trx).
 *
 * The lifecycle is owned by the SDK: the application must NOT commit, roll
 * back or close the transaction itself — the ORM does that when the callback
 * returns (commit) or throws (rollback). Register hooks (onCommit/onRollback/
 * onClose) to react to the outcome; a Topics transactional writer does
 * exactly this.
 */
export interface YdbNativeTransaction {
  /** YDB session id the transaction runs on. */
  readonly sessionId: string;
  /** Server-side transaction id (unique per attempt). */
  readonly transactionId: string;
  /** Signal of the current attempt, if one was passed to execute(). */
  readonly signal?: AbortSignal;
  /** Registers a hook fired BEFORE the SDK commits the transaction. */
  onCommit(fn: (signal?: AbortSignal) => Promise<void> | void): void;
  /** Registers a hook fired when the transaction is rolled back. */
  onRollback(
    fn: (error: unknown, signal?: AbortSignal) => Promise<void> | void,
  ): void;
  /** Registers a hook fired when the transaction is closed (either way). */
  onClose(
    fn: (committed: boolean, signal?: AbortSignal) => Promise<void> | void,
  ): void;
}

interface NativeTransactionBinding {
  readonly tx: YdbNativeTransaction;
  active: boolean;
}

/**
 * Bindings of the native SDK transaction per transactional executor. The
 * binding is registered on the exact executor object the callback receives
 * for THIS attempt; wrappers (logging) inherit it by reference so they
 * resolve to the SAME transaction. A retried attempt receives a fresh
 * executor and therefore a fresh transaction — nothing carries over.
 */
const bindings = new WeakMap<YdbExecutor, NativeTransactionBinding>();

/**
 * Registers the native transaction of the current attempt on the executor
 * handed to the transaction callback. Called by createExecutor() (the real
 * SDK path) and by test mocks. Internal — the application never binds.
 */
export function bindNativeTransaction(
  trx: YdbExecutor,
  tx: {
    sessionId: string;
    transactionId: string;
    onCommit: (fn: (signal?: AbortSignal) => Promise<void> | void) => void;
    onRollback: (
      fn: (error: unknown, signal?: AbortSignal) => Promise<void> | void,
    ) => void;
    onClose: (
      fn: (committed: boolean, signal?: AbortSignal) => Promise<void> | void,
    ) => void;
  },
  signal?: AbortSignal,
): void {
  const binding: NativeTransactionBinding = {
    tx: Object.freeze({
      sessionId: tx.sessionId,
      transactionId: tx.transactionId,
      onCommit: tx.onCommit.bind(tx),
      onRollback: tx.onRollback.bind(tx),
      onClose: tx.onClose.bind(tx),
      signal,
    }),
    active: true,
  };
  bindings.set(trx, binding);
  tx.onClose(() => {
    binding.active = false;
  });
}

/**
 * Lets an executor wrapper (e.g. query logging) share the binding of the
 * executor it wraps, so getNativeTransaction() resolves the SAME native
 * transaction through the wrapper. Wrappers never change transaction
 * ownership; the binding object is shared, including its completion state.
 */
export function inheritNativeTransaction(
  source: YdbExecutor,
  target: YdbExecutor,
): void {
  const binding = bindings.get(source);
  if (binding) bindings.set(target, binding);
}

/**
 * Returns the native YDB transaction of the CURRENT attempt, bound to the
 * transactional executor the callback received from
 * executor.transaction().execute(...) or YdbTransactionManager.runInTransaction().
 *
 * Pass the result directly to @ydbjs/topic's createTxWriter(tx, options) /
 * createTxReader(tx, options) to participate in the same YDB transaction
 * (e.g. table row + topic message commit atomically).
 *
 * Outside a transaction (or after it has completed) this throws a clear
 * error: an ordinary executor is not an active transaction.
 */
export function getNativeTransaction(trx: YdbExecutor): YdbNativeTransaction {
  if (!trx || (typeof trx !== 'object' && typeof trx !== 'function')) {
    throw new Error(
      'getNativeTransaction() expects the transactional executor received ' +
        'inside transaction().execute()/runInTransaction(), got: ' +
        `${String(trx)}.`,
    );
  }
  const binding = bindings.get(trx);
  if (!binding) {
    throw new Error(
      'No native YDB transaction is bound to this executor: ' +
        'getNativeTransaction() must be called INSIDE the transaction ' +
        'callback of transaction().execute()/runInTransaction(), on the ' +
        'executor (trx) argument of that callback.',
    );
  }
  if (!binding.active) {
    throw new Error(
      `YDB transaction ${binding.tx.transactionId} has already completed ` +
        '(committed or rolled back). Handle this attempt only inside its ' +
        'callback; a retried attempt provides a new transaction.',
    );
  }
  return binding.tx;
}
