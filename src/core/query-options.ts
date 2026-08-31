import { YdbExecutor } from './interfaces.js';

export interface QueryOptions {
  /** Transaction / executor */
  trx?: YdbExecutor;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
  /**
   * Query idempotency marker (#27). Passed to SDK as
   * `.idempotent(true)` and allows the ORM retry policy to retry the query
   * on transient errors (ABORTED/UNAVAILABLE/OVERLOADED).
   *
   * WITHOUT the marker the query runs EXACTLY ONCE even with the
   * policy enabled (`YdbModuleOptions.retry`): retrying an unknown write
   * after an ambiguous transport failure could duplicate side effects.
   * Mark only operations that are safe to repeat (idempotent SELECT,
   * INSERT with fixed PK, etc.).
   */
  idempotent?: boolean;
  /** Maximum rows in SELECT (default 100) */
  limit?: number;
  /** Offset for SELECT */
  offset?: number;
  /** Specific columns for SELECT (instead of SELECT *) */
  select?: string[];
}
