import type { YdbQuery } from './interfaces.js';
import type { QueryOptions } from './query-options.js';

/**
 * Applies QueryOptions to a built query and executes it:
 * - signal — cancellation (an already-aborted signal fails immediately);
 * - timeout — per-attempt timeout;
 * - idempotent (#27) — marks the query `.idempotent(true)`, which allows
 *   the retry policy to repeat it; without the marker the query runs
 *   exactly once.
 *
 * Single definition point of this logic for persistence and relations —
 * previously it was duplicated in both.
 */
export async function executeYdbQuery<U>(
  query: YdbQuery,
  options?: QueryOptions,
): Promise<U> {
  const { signal, timeout, idempotent } = options ?? {};

  if (signal) {
    if (signal.aborted) throw new Error('Query aborted by signal');
    query.signal(signal);
  }

  if (timeout && timeout > 0) {
    query.timeout(timeout);
  }

  if (idempotent === true) {
    query.idempotent?.(true);
  }

  return (await query) as U;
}
