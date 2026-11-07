import { describe, it, expect, jest } from '@jest/globals';
import type { Driver } from '@ydbjs/core';
import type { TX } from '@ydbjs/query';
import type { YdbExecutor } from '../core/interfaces.js';
import { YdbTopics } from './ydb-topics.js';
import {
  bindTopicTransaction,
  resolveTopicTransaction,
} from './transaction-binding.js';
import { wrapExecutorWithLogging } from '../core/query-logger.js';
import {
  createTransactionContext,
  runWithTransactionContext,
  setExecutorIdentity,
} from '../transaction/transaction-context.js';

function fixture() {
  const driver = {} as Driver;
  const closes: Array<() => void> = [];
  const trx = Object.assign(() => undefined, {
    sessionId: 'session',
    transactionId: 'transaction',
    onCommit: jest.fn(),
    onRollback: jest.fn(),
    onClose: (fn: () => void) => closes.push(fn),
  }) as unknown as YdbExecutor & TX;
  bindTopicTransaction(trx, trx, driver);
  const topics = new YdbTopics(driver);
  return { driver, trx, topics, closes };
}

describe('YdbTopics: границы транзакций и ресурсы', () => {
  it('сохраняет привязку через логирование и снимает её после завершения', () => {
    const { driver, trx, closes } = fixture();
    const wrapped = wrapExecutorWithLogging(trx, { log: () => undefined });
    expect(resolveTopicTransaction(wrapped, driver).transactionId).toBe(
      'transaction',
    );
    closes.forEach((close) => close());
    expect(() => resolveTopicTransaction(wrapped, driver)).toThrow(
      'live transaction',
    );
  });

  it('отклоняет чужой драйвер, executor без привязки и read-only', () => {
    const { driver, trx } = fixture();
    expect(() => resolveTopicTransaction(trx, {} as Driver)).toThrow(
      'different YDB driver',
    );
    expect(() =>
      resolveTopicTransaction(
        (() => undefined) as unknown as YdbExecutor,
        driver,
      ),
    ).toThrow('live transaction');
    bindTopicTransaction(trx, trx, driver, 'snapshotReadOnly');
    expect(() => resolveTopicTransaction(trx, driver)).toThrow(
      'serializableReadWrite',
    );
  });

  it('снимок SDK TX не изменяется при переиспользовании callable', () => {
    const { driver, trx } = fixture();
    const snapshot = resolveTopicTransaction(trx, driver);
    trx.transactionId = 'other';
    expect(snapshot.transactionId).toBe('transaction');
  });

  it('отклоняет операцию при уже прерванном сигнале привязки', () => {
    const { driver, trx } = fixture();
    // Сигнал транзакции (таймаут/отмена) уже сработал — ресурс не создаётся.
    bindTopicTransaction(
      trx,
      trx,
      driver,
      'serializableReadWrite',
      AbortSignal.abort(),
    );
    let caught: unknown;
    try {
      resolveTopicTransaction(trx, driver);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe('AbortError');
  });

  it('ambient не позволяет использовать транзакцию другого драйвера', async () => {
    const { trx } = fixture();
    const topics = new YdbTopics({} as Driver);
    const id = Symbol();
    setExecutorIdentity(trx, id);
    await runWithTransactionContext(
      createTransactionContext({
        trx,
        db: trx,
        transactionId: id,
        ambient: true,
      }),
      async () => {
        expect(() => topics.createWriter({ topic: 'news' })).toThrow(
          'different YDB driver',
        );
        await Promise.resolve();
      },
    );
  });

  it('запрещает обход через options.tx и создание ресурсов после close', async () => {
    const { topics } = fixture();
    expect(() =>
      topics.createWriter({ topic: 'news', tx: {} } as never),
    ).toThrow('via { trx }');
    await topics.close();
    await topics.close();
    expect(() =>
      topics.createReader({ topic: 'news', consumer: 'search' }),
    ).toThrow('closed');
  });
});
