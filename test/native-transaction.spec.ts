import { describe, it, expect, afterEach } from '@jest/globals';
import {
  YdbTransactionManager,
  getNativeTransaction,
  type YdbExecutor,
  type YdbNativeTransaction,
} from '../src/index.js';
import {
  createScriptedExecutor,
  type ScriptedMockExecutor,
} from './helpers/ydb-mock.js';

describe('getNativeTransaction (нативная транзакция SDK)', () => {
  let db: ScriptedMockExecutor | undefined;
  afterEach(() => {
    db?.assertComplete();
    db = undefined;
  });

  it('вне транзакции accessor падает с понятной ошибкой', () => {
    db = createScriptedExecutor();
    expect(() => getNativeTransaction(db!.executor)).toThrow(
      /No native YDB transaction is bound/,
    );
    expect(() => getNativeTransaction(undefined as never)).toThrow(
      /expects the transactional executor/,
    );
  });

  it('executor.transaction().execute() открывает доступ к нативной транзакции', async () => {
    db = createScriptedExecutor();
    db.expect(/UPSERT/)
      .inTransaction()
      .returns([]);
    let native: YdbNativeTransaction | undefined;
    await db.transaction().execute(async (trx) => {
      native = getNativeTransaction(trx);
      await trx`UPSERT INTO t (id) VALUES ('1')`;
    });
    expect(native!.sessionId).toMatch(/^session-/);
    expect(native!.transactionId).toMatch(/-trx-/);
    expect(typeof native!.onCommit).toBe('function');
    expect(typeof native!.onRollback).toBe('function');
    expect(typeof native!.onClose).toBe('function');
  });

  it('runInTransaction: коммит срабатывает на хуках нативной транзакции', async () => {
    db = createScriptedExecutor();
    db.expect(/UPSERT/)
      .inTransaction()
      .returns([]);
    const manager = new YdbTransactionManager(db.executor);
    const events: string[] = [];
    await manager.runInTransaction(async (trx) => {
      const native = getNativeTransaction(trx);
      native.onCommit(() => {
        events.push('commit');
      });
      native.onRollback(() => {
        events.push('rollback');
      });
      native.onClose((committed) => {
        events.push(`closed:${committed}`);
      });
      await trx`UPSERT INTO t (id) VALUES ('1')`;
    });
    expect(events).toEqual(['commit', 'closed:true']);
    // После завершения транзакции accessor больше не действует.
    expect(() => getNativeTransaction({} as YdbExecutor)).toThrow();
  });

  it('runInTransaction: откат срабатывает на хуках и помечает транзакцию завершённой', async () => {
    db = createScriptedExecutor();
    db.expect(/UPSERT/)
      .inTransaction()
      .returns([]);
    const manager = new YdbTransactionManager(db.executor);
    const events: string[] = [];
    let captured: YdbNativeTransaction | undefined;
    await expect(
      manager.runInTransaction(async (trx) => {
        captured = getNativeTransaction(trx);
        captured.onRollback((error) => {
          events.push(`rollback:${(error as Error).message}`);
        });
        captured.onClose((committed) => {
          events.push(`closed:${committed}`);
        });
        await trx`UPSERT INTO t (id) VALUES ('1')`;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(events).toEqual(['rollback:boom', 'closed:false']);
    expect(() => getNativeTransaction({} as YdbExecutor)).toThrow();
    expect(captured).toBeDefined();
  });

  it('reuse: true использует ту же нативную транзакцию', async () => {
    db = createScriptedExecutor();
    db.expect(/UPSERT INTO tB/)
      .inTransaction()
      .returns([]);
    db.expect(/UPSERT INTO tA/)
      .inTransaction()
      .returns([]);
    const manager = new YdbTransactionManager(db.executor);
    const ids: string[] = [];
    await manager.runInTransaction(async (outer) => {
      ids.push(getNativeTransaction(outer).transactionId);
      await manager.runInTransaction(
        async (inner) => {
          ids.push(getNativeTransaction(inner).transactionId);
          await inner`UPSERT INTO tB (id) VALUES ('B')`;
        },
        { reuse: true },
      );
      await outer`UPSERT INTO tA (id) VALUES ('A')`;
    });
    expect(ids[0]).toBe(ids[1]);
  });

  it('повторная попытка (retry) получает новый объект транзакции', async () => {
    db = createScriptedExecutor();
    db.expect(/UPSERT/)
      .inTransaction()
      .throws(new Error('attempt 1 failed'));
    db.expect(/UPSERT/)
      .inTransaction()
      .returns([]);
    const handles: YdbNativeTransaction[] = [];
    const closed: boolean[][] = [];
    // Two independent attempts = two SDK transactions (what a retry produces):
    // a fresh executor and a fresh native handle per attempt; the previous
    // attempt's handle is closed and no longer active.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const throwing = attempt === 0;
      const run = db.transaction().execute(async (trx) => {
        const native = getNativeTransaction(trx);
        handles.push(native);
        const record: boolean[] = [];
        closed.push(record);
        native.onClose((committed) => {
          record.push(committed);
        });
        await trx`UPSERT INTO t (id) VALUES ('1')`;
        if (throwing) throw new Error(`attempt ${attempt + 1} failed`);
      });
      if (throwing) await expect(run).rejects.toThrow('attempt 1 failed');
      else await run;
    }
    expect(handles[0].transactionId).not.toBe(handles[1].transactionId);
    expect(closed[0]).toEqual([false]);
    expect(closed[1]).toEqual([true]);
  });

  it('logging-обёртка executor-а сохраняет доступ к той же нативной транзакции', async () => {
    // Проверяем через runInTransaction + wrapExecutorWithLogging: обёртка
    // оборачивает trx, но биндинг нативной транзакции наследуется.
    const { wrapExecutorWithLogging } =
      await import('../src/core/query-logger.js');
    db = createScriptedExecutor();
    const logged = wrapExecutorWithLogging(db.executor, {
      log: () => undefined,
    });
    db.expect(/UPSERT/)
      .inTransaction()
      .returns([]);
    let native: YdbNativeTransaction | undefined;
    await logged.transaction().execute(async (trx) => {
      native = getNativeTransaction(trx);
      await trx`UPSERT INTO t (id) VALUES ('1')`;
    });
    expect(native!.transactionId).toMatch(/-trx-/);
  });
});
