import { beforeAll, afterAll, describe, it, expect } from '@jest/globals';
import { create } from '@bufbuild/protobuf';
import { topic as createTopicClient } from '@ydbjs/topic';
import { identifier } from '@ydbjs/query';
import {
  TopicServiceDefinition,
  CreateTopicRequestSchema,
  DropTopicRequestSchema,
} from '@ydbjs/api/topic';
import {
  createExecutor,
  getNativeTransaction,
  YdbTransactionManager,
  type YdbExecutor,
  type YdbNativeTransaction,
} from '../../src/index.js';
import { abortedTransactionError } from '../helpers/ydb-responses.js';
import {
  createE2eContext,
  hasYdbCredentials,
  type E2eContext,
} from './setup.js';

const suite = hasYdbCredentials() ? describe : describe.skip;

/**
 * Native transaction accessor (Topics): getNativeTransaction(trx) returns
 * the raw @ydbjs/query TX, which can be passed to @ydbjs/topic's
 * createTxWriter/createTxReader WITHOUT type assertions. Verified against
 * real YDB: table row + topic message commit/rollback atomically.
 */
suite('YDB Topics: нативная транзакция через getNativeTransaction', () => {
  let ctx: E2eContext;
  let db: YdbExecutor;
  let manager: YdbTransactionManager;
  const prefix = `orm_ntx_${Date.now()}`;
  const table = `${prefix}_rows`;
  const paths: string[] = [];
  // The SDK rolls back a transaction fire-and-forget: wait briefly before
  // follow-up queries after a rollback (see topics.e2e.spec.ts).
  const ROLLBACK_SETTLE_MS = 500;

  beforeAll(async () => {
    ctx = (await createE2eContext())!;
    db = createExecutor(ctx.driver, {
      endpoint: 'unused',
      logQueries: { log: () => undefined },
    });
    manager = new YdbTransactionManager(db);
    await db`CREATE TABLE ${identifier(table)} (id Utf8 NOT NULL, PRIMARY KEY (id))`;
  }, 60000);

  afterAll(async () => {
    if (!ctx) return;
    const client = ctx.driver.createClient(TopicServiceDefinition);
    for (const path of paths)
      await client.dropTopic(create(DropTopicRequestSchema, { path }));
    await db`DROP TABLE ${identifier(table)}`;
    ctx.driver.close();
  }, 60000);

  async function provision(name: string) {
    const path = `${ctx.dbPath}/${prefix}_${name}`;
    const response = await ctx.driver
      .createClient(TopicServiceDefinition)
      .createTopic(
        create(CreateTopicRequestSchema, {
          path,
          partitioningSettings: { minActivePartitions: 1n },
          consumers: [{ name: 'processor' }],
        }),
      );
    expect(response.operation?.status).toBe(400000);
    paths.push(path);
    return path;
  }

  async function countRows(id: string): Promise<number> {
    const rows = await db`SELECT id FROM ${identifier(table)} WHERE id = ${id}`;
    return rows[0].length;
  }

  async function countMessages(path: string): Promise<number> {
    const client = createTopicClient(ctx.driver);
    const reader = client.createReader({ topic: path, consumer: 'processor' });
    let count = 0;
    try {
      for await (const batch of reader.read({
        limit: 10,
        waitMs: 2000,
        signal: AbortSignal.timeout(10000),
      }))
        count += batch.length;
    } finally {
      if ('close' in reader) await reader.close();
    }
    return count;
  }

  it('commit: строка и сообщение сохраняются вместе (runInTransaction)', async () => {
    const path = await provision('commit');
    const topics = createTopicClient(ctx.driver);
    await manager.runInTransaction(async (trx) => {
      const nativeTx = getNativeTransaction(trx);
      // Type-level check: no casts — the accessor result is accepted by
      // @ydbjs/topic's createTxWriter as is.
      const writer = topics.createTxWriter(nativeTx, {
        topic: path,
        producer: 'commit',
      });
      await trx`UPSERT INTO ${identifier(table)} (id) VALUES ('committed')`;
      writer.write(new TextEncoder().encode('committed'));
      await writer.flush();
    });
    expect(await countRows('committed')).toBe(1);
    expect(await countMessages(path)).toBe(1);
  }, 60000);

  it('executor.transaction().execute(): та же нативная транзакция доступна', async () => {
    const path = await provision('direct');
    const topics = createTopicClient(ctx.driver);
    let transactionId: string | undefined;
    await db.transaction().execute(async (trx) => {
      const nativeTx = getNativeTransaction(trx);
      transactionId = nativeTx.transactionId;
      const writer = topics.createTxWriter(nativeTx, {
        topic: path,
        producer: 'direct',
      });
      await trx`UPSERT INTO ${identifier(table)} (id) VALUES ('direct')`;
      writer.write(new TextEncoder().encode('direct'));
      await writer.flush();
    });
    expect(transactionId).toBeTruthy();
    expect(await countRows('direct')).toBe(1);
    expect(await countMessages(path)).toBe(1);
  }, 60000);

  it('rollback: подтверждённая в транзакции отправка откатывается вместе со строкой', async () => {
    const path = await provision('rollback');
    const topics = createTopicClient(ctx.driver);
    const statuses: Array<'written' | 'writtenInTx' | 'skipped'> = [];
    await expect(
      manager.runInTransaction(async (trx) => {
        const nativeTx = getNativeTransaction(trx);
        const writer = topics.createTxWriter(nativeTx, {
          topic: path,
          producer: 'rollback',
          onAck: (_seqNo, status) => {
            if (status) statuses.push(status);
          },
        });
        await trx`UPSERT INTO ${identifier(table)} (id) VALUES ('rolled_back')`;
        writer.write(new TextEncoder().encode('rolled_back'));
        await writer.flush();
        throw new Error('intentional rollback');
      }),
    ).rejects.toThrow('intentional rollback');
    await new Promise((resolve) => setTimeout(resolve, ROLLBACK_SETTLE_MS));
    expect(await countRows('rolled_back')).toBe(0);
    expect(await countMessages(path)).toBe(0);
    // The server acknowledged the write inside the transaction before the
    // rollback — but the message never becomes visible to consumers.
    expect(statuses).toContain('writtenInTx');
  }, 60000);

  it('reuse: true — вложенный вызов видит ту же нативную транзакцию', async () => {
    const path = await provision('reuse');
    const topics = createTopicClient(ctx.driver);
    const ids: string[] = [];
    await manager.runInTransaction(async (outer) => {
      ids.push(getNativeTransaction(outer).transactionId);
      await manager.runInTransaction(
        async (inner) => {
          ids.push(getNativeTransaction(inner).transactionId);
          const writer = topics.createTxWriter(getNativeTransaction(inner), {
            topic: path,
            producer: 'reuse',
          });
          await inner`UPSERT INTO ${identifier(table)} (id) VALUES ('reused')`;
          writer.write(new TextEncoder().encode('reused'));
          await writer.flush();
        },
        { reuse: true },
      );
    });
    expect(ids[0]).toBe(ids[1]);
    expect(await countRows('reused')).toBe(1);
    expect(await countMessages(path)).toBe(1);
  }, 60000);

  it('retry-политика: новая попытка получает новую нативную транзакцию', async () => {
    const path = await provision('retry');
    const topics = createTopicClient(ctx.driver);
    const attempts: string[] = [];
    const firstCloseStates: boolean[] = [];
    let firstHandle: YdbNativeTransaction | undefined;
    await manager.runInTransaction(
      async (trx) => {
        const nativeTx = getNativeTransaction(trx);
        attempts.push(nativeTx.transactionId);
        if (!firstHandle) {
          firstHandle = nativeTx;
          firstHandle.onClose((committed) => {
            firstCloseStates.push(committed);
          });
        }
        const writer = topics.createTxWriter(nativeTx, {
          topic: path,
          producer: `retry_${attempts.length}`,
        });
        writer.write(new TextEncoder().encode(`attempt_${attempts.length}`));
        await writer.flush();
        if (attempts.length === 1) {
          // ABORTED — retryable by the ORM policy.
          throw abortedTransactionError();
        }
      },
      {
        retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
        signal: AbortSignal.timeout(30000),
      },
    );
    // The retried attempt used a NEW transaction, and the handle of attempt 1
    // was closed (rolled back) — nothing carries over.
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).not.toBe(attempts[1]);
    expect(firstCloseStates).toEqual([false]);
    expect(await countRows('attempt_2')).toBe(1);
    expect(await countMessages(path)).toBe(1);
  }, 60000);
});
