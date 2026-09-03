import { describe, expect, it, jest } from '@jest/globals';
import type { Driver } from '@ydbjs/core';
import {
  readBookkeepingSnapshot,
  type MigrationBookkeepingDeps,
} from './migration-bookkeeping.js';
import { MIGRATIONS_TABLE } from './migration-runner.js';

/** Executor mock: records SQL, returns rows for SELECT. */
function makeExecutor(rows: Record<string, unknown>[] = []) {
  const executedSql: string[] = [];
  const executor: any = jest.fn((strings: TemplateStringsArray) => {
    const sql = strings[0];
    const query: any = {
      parameter() {
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
      then(
        onFulfilled?: ((value: unknown[][]) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) {
        return Promise.resolve()
          .then(() => {
            executedSql.push(sql);
            if (sql.trimStart().startsWith('SELECT')) return [rows];
            throw new Error(`Unexpected SQL in read-only path: ${sql}`);
          })
          .then(onFulfilled ?? undefined, onRejected ?? undefined);
      },
    };
    return query;
  });
  return { executor: executor as unknown, executedSql };
}

const depsOf = (executor: unknown): MigrationBookkeepingDeps => ({
  driver: {} as Driver,
  executor: executor as any,
});

describe('readBookkeepingSnapshot (#152, read-only)', () => {
  it('missing table: exists=false, records=[], executor is never touched', async () => {
    const mock = makeExecutor();
    const describeTable = jest.fn((_tableName: string): Promise<null> =>
      Promise.resolve(null),
    );

    const snapshot = await readBookkeepingSnapshot(depsOf(mock.executor), {
      describeTable,
    });

    expect(snapshot).toEqual({ exists: false, legacy: false, records: [] });
    expect(describeTable).toHaveBeenCalledWith(MIGRATIONS_TABLE);
    // No queries at all: no table — nothing to read, nothing to create.
    expect(mock.executedSql).toEqual([]);
  });

  it('modern table: bare SELECT of all columns, rows mapped and sorted', async () => {
    const rows = [
      { id: 2, timestamp: 2000, name: '2-B', hash: 'hb', state: 'applied' },
      { id: 1, timestamp: 1000, name: '1-A', hash: 'ha', state: 'applied' },
    ];
    const mock = makeExecutor(rows);
    const describeTable = jest.fn((): Promise<any> =>
      Promise.resolve({
        columns: new Map([
          ['id', 3 as never],
          ['timestamp', 3 as never],
          ['name', 4 as never],
          ['hash', 4 as never],
          ['state', 4 as never],
        ]),
        primaryKey: ['id'],
        indexes: [],
      }),
    );

    const snapshot = await readBookkeepingSnapshot(depsOf(mock.executor), {
      describeTable,
    });

    expect(snapshot.exists).toBe(true);
    expect(snapshot.legacy).toBe(false);
    expect(snapshot.records.map((r) => r.name)).toEqual(['1-A', '2-B']);

    // Exactly one bare SELECT, no CREATE/ALTER/probe.
    expect(mock.executedSql).toHaveLength(1);
    const sql = mock.executedSql[0];
    expect(sql).toMatch(
      /^SELECT `id`, `timestamp`, `name`, `hash`, `state` FROM `ydb_migrations`$/,
    );
  });

  it('legacy table (no hash/state columns): SELECT without them, no ALTER (#101)', async () => {
    const rows = [{ id: 7, timestamp: 5000, name: 'only-name' }];
    const mock = makeExecutor(rows);
    const describeTable = jest.fn((): Promise<any> =>
      Promise.resolve({
        // Legacy table before #101: only the base columns.
        columns: new Map([
          ['id', 3 as never],
          ['timestamp', 3 as never],
          ['name', 4 as never],
        ]),
        primaryKey: ['id'],
        indexes: [],
      }),
    );

    const snapshot = await readBookkeepingSnapshot(depsOf(mock.executor), {
      describeTable,
    });

    expect(snapshot.exists).toBe(true);
    expect(snapshot.legacy).toBe(true);
    expect(snapshot.records).toEqual([
      {
        id: 7,
        timestamp: 5000,
        name: 'only-name',
        hash: undefined,
        state: 'applied',
      },
    ]);

    const sql = mock.executedSql[0];
    // The hash/state columns are NOT requested and NOTHING is added.
    expect(sql).toBe('SELECT `id`, `timestamp`, `name` FROM `ydb_migrations`');
    expect(mock.executedSql.every((s) => !/ALTER/i.test(s))).toBe(true);
  });

  it('partial legacy (only state column) still counts as legacy and reads safely', async () => {
    const mock = makeExecutor([{ id: 1, timestamp: 1, name: 'x' }]);
    const describeTable = jest.fn((): Promise<any> =>
      Promise.resolve({
        columns: new Map([
          ['id', 3 as never],
          ['timestamp', 3 as never],
          ['name', 4 as never],
          ['state', 4 as never],
        ]),
        primaryKey: ['id'],
        indexes: [],
      }),
    );

    const snapshot = await readBookkeepingSnapshot(depsOf(mock.executor), {
      describeTable,
    });

    expect(snapshot.legacy).toBe(true);
    expect(mock.executedSql[0]).not.toContain('`state`');
    expect(mock.executedSql[0]).not.toContain('`hash`');
  });

  it('DescribeTable errors propagate as-is (nothing swallowed)', async () => {
    const mock = makeExecutor();
    const describeTable = jest.fn((): Promise<null> =>
      Promise.reject(new Error('SCHEME_ERROR: access denied')),
    );

    await expect(
      readBookkeepingSnapshot(depsOf(mock.executor), { describeTable }),
    ).rejects.toThrow('access denied');
    expect(mock.executedSql).toEqual([]);
  });

  it('SELECT failure propagates as-is (read-only path has no fallback DDL)', async () => {
    const failing: any = jest.fn(() => {
      const query: any = {
        parameter() {
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
        then(
          _onFulfilled?: unknown,
          onRejected?: ((r: unknown) => unknown) | null,
        ) {
          return Promise.reject(new Error('table is unavailable')).then(
            undefined,
            onRejected,
          );
        },
      };
      return query;
    });
    const describeTable = jest.fn((): Promise<any> =>
      Promise.resolve({
        columns: new Map([['id', 3 as never]]),
        primaryKey: ['id'],
        indexes: [],
      }),
    );

    await expect(
      readBookkeepingSnapshot(depsOf(failing), { describeTable }),
    ).rejects.toThrow('table is unavailable');
  });
});
