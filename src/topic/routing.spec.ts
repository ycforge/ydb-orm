import { describe, it, expect, jest } from '@jest/globals';
import type { Driver } from '@ydbjs/core';
import type { TX } from '@ydbjs/query';
import type { YdbExecutor } from '../core/interfaces.js';
import {
  bindTopicTransaction,
  resolveTopicTransaction,
} from './transaction-binding.js';
import {
  createTransactionContext,
  runWithTransactionContext,
} from '../transaction/transaction-context.js';
import { YdbTransactionManager } from '../transaction/transaction.manager.js';

const makeResource = () => ({
  read: jest.fn(),
  write: jest.fn(),
  flush: jest.fn(),
  commit: jest.fn(),
  close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  destroy: jest.fn(),
});
const client = {
  createReader: jest.fn((_tx?: unknown, _options?: unknown) => makeResource()),
  createWriter: jest.fn((_tx?: unknown, _options?: unknown) => makeResource()),
  createTxReader: jest.fn((_tx?: unknown, _options?: unknown) =>
    makeResource(),
  ),
  createTxWriter: jest.fn((_tx?: unknown, _options?: unknown) =>
    makeResource(),
  ),
};
jest.unstable_mockModule('@ydbjs/topic', () => ({ topic: () => client }));
const { YdbTopics } = await import('./ydb-topics.js');

function txFixture(driver: Driver) {
  const trx = Object.assign(() => undefined, {
    sessionId: 'session',
    transactionId: 'tx',
    onCommit: jest.fn(),
    onRollback: jest.fn(),
    onClose: jest.fn(),
  }) as unknown as TX & YdbExecutor;
  bindTopicTransaction(trx, trx, driver);
  return trx;
}

describe('YdbTopics: маршрутизация SDK', () => {
  it('обычный consumer фиксируется явно; close освобождает все ресурсы при ошибке', async () => {
    const topics = new YdbTopics({} as Driver);
    const rawReader = makeResource();
    const rawWriter = makeResource();
    rawReader.close.mockRejectedValueOnce(new Error('close failure'));
    const readerDestroy = rawReader.destroy;
    const writerClose = rawWriter.close;
    const writerDestroy = rawWriter.destroy;
    client.createReader.mockReturnValueOnce(rawReader);
    client.createWriter.mockReturnValueOnce(rawWriter);
    const reader = topics.createReader({ topic: 'news', consumer: 'search' });
    const writer = topics.createWriter({ topic: 'news' });
    expect('commit' in reader).toBe(true);
    await expect(topics.close()).rejects.toThrow(AggregateError);
    expect(readerDestroy).toHaveBeenCalled();
    expect(writerClose).toHaveBeenCalled();
    expect(writerDestroy).toHaveBeenCalled();
    expect('close' in writer).toBe(true);
  });

  it('явный trx и ambient используют SDK TX и скрывают опасное ручное закрытие', async () => {
    const driver = {} as Driver;
    const trx = txFixture(driver);
    const topics = new YdbTopics(driver);
    const reader = topics.createReader(
      { topic: 'news', consumer: 'search' },
      { trx },
    );
    expect('commit' in reader).toBe(false);
    expect('close' in reader).toBe(false);
    await runWithTransactionContext(
      createTransactionContext({
        transactionId: Symbol(),
        trx,
        db: trx,
        ambient: true,
      }),
      async () => {
        const writer = topics.createWriter({ topic: 'results' });
        expect('close' in writer).toBe(false);
        writer.write(new Uint8Array([1]));
        await writer.flush();
        const readerTx = client.createTxReader.mock.calls.at(-1)![0];
        expect(client.createTxWriter.mock.calls.at(-1)![0]).toBe(readerTx);
        const raw = client.createTxWriter.mock.results.at(-1)!
          .value as ReturnType<typeof makeResource>;
        expect(raw.write).toHaveBeenCalledWith(new Uint8Array([1]), undefined);
      },
    );
    await topics.close();
  });

  it('не смешивает явный trx и другую ambient-транзакцию', async () => {
    const driver = {} as Driver;
    const trx = txFixture(driver);
    const foreign = txFixture(driver);
    const topics = new YdbTopics(driver);
    await runWithTransactionContext(
      createTransactionContext({
        transactionId: Symbol(),
        trx,
        db: trx,
        ambient: true,
      }),
      async () => {
        expect(() =>
          topics.createWriter({ topic: 'news' }, { trx: foreign }),
        ).toThrow('mixing');
        await Promise.resolve();
      },
    );
    await topics.close();
  });

  it('не даёт ресурсу тихо выйти из активной не-ambient транзакции', async () => {
    const driver = {} as Driver;
    const trx = txFixture(driver);
    const topics = new YdbTopics(driver);
    await runWithTransactionContext(
      createTransactionContext({
        transactionId: Symbol(),
        trx,
        db: trx,
        ambient: false,
      }),
      async () => {
        expect(() => topics.createWriter({ topic: 'news' })).toThrow(
          'escape the active transaction',
        );
        expect(() =>
          topics.createReader({ topic: 'news', consumer: 'search' }),
        ).toThrow('escape the active transaction');
        await Promise.resolve();
      },
    );
    // Outside a transaction resources are still created without restrictions.
    expect('close' in topics.createWriter({ topic: 'news' })).toBe(true);
    await topics.close();
  });

  it('явный trx, совпадающий с ambient, использует ту же транзакцию SDK', async () => {
    const driver = {} as Driver;
    const trx = txFixture(driver);
    const topics = new YdbTopics(driver);
    await runWithTransactionContext(
      createTransactionContext({
        transactionId: Symbol(),
        trx,
        db: trx,
        ambient: true,
      }),
      async () => {
        const writer = topics.createWriter({ topic: 'news' }, { trx });
        expect('close' in writer).toBe(false);
        // Same SDK TX snapshot as the ambient transaction: no mixing error.
        const expected = resolveTopicTransaction(trx, driver);
        expect(client.createTxWriter.mock.calls.at(-1)![0]).toBe(expected);
        await Promise.resolve();
      },
    );
    await topics.close();
  });

  it('allows an explicit trx inside a non-ambient transaction', async () => {
    const driver = {} as Driver;
    const trx = txFixture(driver);
    const topics = new YdbTopics(driver);

    await runWithTransactionContext(
      createTransactionContext({
        transactionId: Symbol(),
        trx,
        db: trx,
        ambient: false,
      }),
      async () => {
        const writer = topics.createWriter({ topic: 'news' }, { trx });
        expect('close' in writer).toBe(false);

        const foreign = txFixture(driver);
        expect(() =>
          topics.createWriter({ topic: 'news' }, { trx: foreign }),
        ).toThrow('mixing');
        await Promise.resolve();
      },
    );
    await topics.close();
  });

  it('treats an explicitly undefined options.tx as absent', async () => {
    const topics = new YdbTopics({} as Driver);
    const writer = topics.createWriter({
      topic: 'news',
      tx: undefined,
    } as never);

    expect('close' in writer).toBe(true);
    if ('close' in writer) await writer.close();
    await topics.close();
  });

  it('supports the documented runInTransaction + explicit { trx } pattern', async () => {
    const driver = {} as Driver;
    const trx = txFixture(driver);
    const topics = new YdbTopics(driver);
    const db = Object.assign(
      () => {
        throw new Error('query is not expected in this test');
      },
      {
        transaction: () => ({
          execute: (fn: (trx: YdbExecutor, signal?: AbortSignal) => unknown) =>
            Promise.resolve(fn(trx)),
        }),
      },
    ) as unknown as YdbExecutor;
    const manager = new YdbTransactionManager(db);

    await manager.runInTransaction(async (transactionExecutor) => {
      const writer = topics.createWriter(
        { topic: 'news' },
        { trx: transactionExecutor },
      );
      expect('close' in writer).toBe(false);
      await Promise.resolve();
    });

    await topics.close();
  });

  it('ignores a non-ambient context of another configuration', async () => {
    const driver = {} as Driver;
    const foreignDriver = {} as Driver;
    const foreignTrx = txFixture(foreignDriver);
    const topics = new YdbTopics(driver);

    await runWithTransactionContext(
      createTransactionContext({
        transactionId: Symbol(),
        trx: foreignTrx,
        db: foreignTrx,
        ambient: false,
      }),
      async () => {
        const writer = topics.createWriter({ topic: 'news' });
        expect('close' in writer).toBe(true);
        await Promise.resolve();
      },
    );
    await topics.close();
  });
});
