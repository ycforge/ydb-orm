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
 */
export function createMockExecutor(rows: any[][] = [[]]): MockExecutor {
  const queries: RecordedQuery[] = [];

  const executor: any = jest.fn((strings: TemplateStringsArray) => {
    const recorded: RecordedQuery = { sql: strings[0], params: {} };
    queries.push(recorded);

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
        return Promise.resolve(rows).then(onFulfilled, onRejected);
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
