import type { YdbQuery } from './interfaces.js';
import type { QueryOptions } from './query-options.js';

/**
 * Применяет QueryOptions к построенному запросу и выполняет его:
 * - signal — отмена (уже абортнутый сигнал — немедленная ошибка);
 * - timeout — таймаут на попытку;
 * - idempotent (#27) — пометка `.idempotent(true)`, разрешающая
 *   retry-политике повторять запрос; без пометки запрос выполняется
 *   ровно один раз.
 *
 * Единая точка этой логики для persistence и relations — раньше
 * дублировалась в обоих.
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
