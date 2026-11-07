import { describe, it, expect, jest } from '@jest/globals';
import type { Driver } from '@ydbjs/core';
import type { TX } from '@ydbjs/query';
import type { YdbExecutor } from '../core/interfaces.js';
import { bindTopicTransaction } from './transaction-binding.js';
import {
  createTransactionContext,
  runWithTransactionContext,
} from '../transaction/transaction-context.js';

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
        const raw = client.createTxWriter.mock.results.at(-1)!.value;
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
});
