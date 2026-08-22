import { jest } from '@jest/globals';
import type { YdbExecutor } from '../../src/index.js';

export interface RecordedQuery {
  sql: string;
  params: Record<string, unknown>;
}

export interface MockExecutor {
  executor: YdbExecutor;
  /** Все выполненные запросы (SQL + параметры). */
  queries: RecordedQuery[];
}

/**
 * Мок YdbExecutor: записывает SQL и параметры, резолвится заданными строками.
 * transaction().execute(fn) вызывает fn с тем же моком в роли trx.
 * Сети нет — используется в тестах NestJS-интеграции через overrideProvider.
 *
 * options.sequential — каждый запрос получает СВОЙ набор result sets
 * (rows[0] — первый запрос, rows[1] — второй и т.д.; последний элемент
 * повторяется для лишних запросов). По умолчанию все запросы получают
 * один и тот же массив result sets.
 */
export function createMockExecutor(
  rows: any[][] = [[]],
  options?: { sequential?: boolean },
): MockExecutor {
  const queries: RecordedQuery[] = [];
  let callIndex = 0;

  const executor: any = jest.fn((strings: TemplateStringsArray) => {
    const recorded: RecordedQuery = { sql: strings[0], params: {} };
    queries.push(recorded);

    const resultRows = options?.sequential
      ? (rows[Math.min(callIndex++, rows.length - 1)] ?? [])
      : rows;

    const query: any = {
      parameter(name: string, value: unknown) {
        recorded.params[name] = value;
        return query;
      },
      timeout() {
        return query;
      },
      signal() {
        return query;
      },
      cancel() {
        return query;
      },
      then(onFulfilled: any, onRejected: any) {
        return Promise.resolve(resultRows).then(onFulfilled, onRejected);
      },
    };
    return query;
  });

  executor.transaction = () => ({
    execute: (fn: (trx: YdbExecutor) => Promise<unknown>) =>
      fn(executor as YdbExecutor),
  });

  return { executor: executor as YdbExecutor, queries };
}
