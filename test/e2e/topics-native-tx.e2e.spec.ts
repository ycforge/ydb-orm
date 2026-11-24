import { beforeAll, afterAll, describe, it, expect } from '@jest/globals';
import { create } from '@bufbuild/protobuf';
import { topic as createTopicClient } from '@ydbjs/topic';
import { identifier } from '@ydbjs/query';
import {
  TopicServiceDefinition,
  CreateTopicRequestSchema,
  DropTopicRequestSchema,
} from '@ydbjs/api/topic';
import type { TopicMessage } from '@ydbjs/topic/message';
import type { TopicTxReader } from '@ydbjs/topic/reader';
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
  const paths: string[] = [];
  const tables: string[] = [];
  const mainTable = `${prefix}_rows`;
  tables.push(mainTable);
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
    await db`CREATE TABLE ${identifier(mainTable)} (id Utf8 NOT NULL, PRIMARY KEY (id))`;
  }, 60000);

  afterAll(async () => {
    if (!ctx) return;
    const client = ctx.driver.createClient(TopicServiceDefinition);
    for (const path of paths) {
      const response = await client.dropTopic(
        create(DropTopicRequestSchema, { path }),
      );
      expect(response.operation?.status).toBe(400000);
    }
    for (const table of tables) await db`DROP TABLE ${identifier(table)}`;
    ctx.driver.close();
  }, 60000);

  async function provision(name: string, consumer = 'processor') {
    const path = `${ctx.dbPath}/${prefix}_${name}`;
    const response = await ctx.driver
      .createClient(TopicServiceDefinition)
      .createTopic(
        create(CreateTopicRequestSchema, {
          path,
          partitioningSettings: { minActivePartitions: 1n },
          consumers: [{ name: consumer }],
        }),
      );
    expect(response.operation?.status).toBe(400000);
    paths.push(path);
    return path;
  }

  async function createResultsTable(name: string) {
    const table = `${prefix}_${name}`;
    tables.push(table);
    await db`CREATE TABLE ${identifier(table)} (id Utf8 NOT NULL, PRIMARY KEY (id))`;
    return table;
  }

  async function countRows(table: string, id: string): Promise<number> {
    const rows = await db`SELECT id FROM ${identifier(table)} WHERE id = ${id}`;
    return rows[0].length;
  }

  /** Ordinary (non-tx) writer: seed/cleanup helper, closed right after flush. */
  async function seedMessage(
    path: string,
    payload: string,
    producer: string,
  ): Promise<void> {
    const client = createTopicClient(ctx.driver);
    const writer = client.createWriter({ topic: path, producer });
    writer.write(new TextEncoder().encode(payload));
    await writer.flush();
    if ('close' in writer) await writer.close();
  }

  /**
   * Reads with an ordinary reader until the bounded wait expires. Resolves
   * [] when the wait elapses with no messages — this is the EXPECTED
   * bounded-completion path, NOT a failure. Network/auth errors propagate.
   */
  async function readOrdinary(
    path: string,
    consumer: string,
    limit = 10,
  ): Promise<TopicMessage[]> {
    const client = createTopicClient(ctx.driver);
    // Track partition assignment: a completed read() with zero messages is
    // only proof of "no redelivery" if a partition was actually assigned and
    // the server-side committed offset equals the partition end. Without
    // this, a failed connect / early abort could masquerade as success.
    const positions: Array<{ committed: bigint; end: bigint }> = [];
    const reader = client.createReader({
      topic: path,
      consumer,
      onPartitionSessionStart: (_session, committed, offsets) => {
        positions.push({ committed, end: offsets.end });
        return Promise.resolve();
      },
    });
    const messages: TopicMessage[] = [];
    try {
      for await (const batch of reader.read({
        limit,
        waitMs: 3000,
        signal: AbortSignal.timeout(15000),
      }))
        messages.push(...batch);
      expect(positions.length).toBeGreaterThan(0);
      if (messages.length === 0) {
        for (const position of positions)
          expect(position.committed).toBe(position.end);
      }
      return messages;
    } finally {
      if ('close' in reader) await reader.close();
    }
  }

  function payload(message: TopicMessage): string {
    return new TextDecoder().decode(message.payload);
  }

  /** Bounded read inside a transaction: exactly one batch, then no more reads. */
  async function readOneTx(reader: TopicTxReader): Promise<TopicMessage[]> {
    const messages: TopicMessage[] = [];
    for await (const batch of reader.read({
      limit: 1,
      waitMs: 10000,
      signal: AbortSignal.timeout(30000),
    })) {
      messages.push(...batch);
    }
    return messages;
  }

  /**
   * The real SDK wraps a failed transaction into Error('Transaction failed.')
   * with the original error in `cause` — assert the STRUCTURE, not just
   * "some error happened".
   */
  function assertTransactionFailedWith(
    error: unknown,
    expectedMessage: string,
  ): void {
    const top = error as Error | undefined;
    expect(top?.message).toBe('Transaction failed.');
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      const cause = (current as { cause?: unknown }).cause;
      if (cause instanceof Error && cause.message === expectedMessage) return;
      current = cause;
    }
    throw new Error(
      `Expected the transaction error cause chain to contain "${expectedMessage}", ` +
        `got: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`,
    );
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
      await trx`UPSERT INTO ${identifier(mainTable)} (id) VALUES ('committed')`;
      writer.write(new TextEncoder().encode('committed'));
      await writer.flush();
    });
    expect(await countRows(mainTable, 'committed')).toBe(1);
    expect(await readOrdinary(path, 'processor')).toHaveLength(1);
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
      await trx`UPSERT INTO ${identifier(mainTable)} (id) VALUES ('direct')`;
      writer.write(new TextEncoder().encode('direct'));
      await writer.flush();
    });
    expect(transactionId).toBeTruthy();
    expect(await countRows(mainTable, 'direct')).toBe(1);
    expect(await readOrdinary(path, 'processor')).toHaveLength(1);
  }, 60000);

  it('rollback: подтверждённая в транзакции отправка откатывается вместе со строкой', async () => {
    const path = await provision('rollback');
    const topics = createTopicClient(ctx.driver);
    const statuses: Array<'written' | 'writtenInTx' | 'skipped'> = [];
    const thrown = await manager
      .runInTransaction(async (trx) => {
        const nativeTx = getNativeTransaction(trx);
        const writer = topics.createTxWriter(nativeTx, {
          topic: path,
          producer: 'rollback',
          onAck: (_seqNo, status) => {
            if (status) statuses.push(status);
          },
        });
        await trx`UPSERT INTO ${identifier(mainTable)} (id) VALUES ('rolled_back')`;
        writer.write(new TextEncoder().encode('rolled_back'));
        await writer.flush();
        throw new Error('intentional rollback');
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(thrown).toBeInstanceOf(Error);
    assertTransactionFailedWith(thrown, 'intentional rollback');
    await new Promise((resolve) => setTimeout(resolve, ROLLBACK_SETTLE_MS));
    expect(await countRows(mainTable, 'rolled_back')).toBe(0);
    expect(await readOrdinary(path, 'processor')).toHaveLength(0);
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
          await inner`UPSERT INTO ${identifier(mainTable)} (id) VALUES ('reused')`;
          writer.write(new TextEncoder().encode('reused'));
          await writer.flush();
        },
        { reuse: true },
      );
    });
    expect(ids[0]).toBe(ids[1]);
    expect(await countRows(mainTable, 'reused')).toBe(1);
    expect(await readOrdinary(path, 'processor')).toHaveLength(1);
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
        // Each attempt writes BOTH the row and the message inside ITS OWN
        // transaction — the failed attempt must not survive anywhere.
        await trx`UPSERT INTO ${identifier(mainTable)} (id) VALUES (${`attempt_${attempts.length}`})`;
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
    expect(await countRows(mainTable, 'attempt_1')).toBe(0);
    expect(await countRows(mainTable, 'attempt_2')).toBe(1);
    const messages = await readOrdinary(path, 'processor');
    expect(messages).toHaveLength(1);
    expect(payload(messages[0])).toBe('attempt_2');
  }, 60000);

  it('tx reader (commit): сообщение прочитано, результат записан, offset закоммичен', async () => {
    const path = await provision('reader_commit', 'reader_commit_consumer');
    const results = await createResultsTable('reader_commit_results');
    const topics = createTopicClient(ctx.driver);
    await seedMessage(path, 'reader_message_1', 'reader_commit_seed');

    let seenSeqNo: bigint | undefined;
    let seenProducer: string | undefined;
    await manager.runInTransaction(async (trx) => {
      const nativeTx = getNativeTransaction(trx);
      // Lifecycle belongs to the transactional hooks — do NOT close the tx
      // reader inside the callback.
      const reader = topics.createTxReader(nativeTx, {
        topic: path,
        consumer: 'reader_commit_consumer',
      });
      const messages = await readOneTx(reader);
      expect(messages).toHaveLength(1);
      seenSeqNo = messages[0].seqNo;
      seenProducer = messages[0].producer;
      expect(payload(messages[0])).toBe('reader_message_1');
      await trx`UPSERT INTO ${identifier(results)} (id) VALUES (${`processed_${messages[0].seqNo}`})`;
    });

    expect(seenSeqNo).toBe(1n);
    expect(seenProducer).toBe('reader_commit_seed');
    expect(await countRows(results, 'processed_1')).toBe(1);
    // The read position was committed together with the result: a NEW reader
    // on the same consumer must not deliver the processed message again
    // (checked after the reader is connected — waitMs bounds the wait).
    const redelivered = await readOrdinary(path, 'reader_commit_consumer', 5);
    expect(redelivered).toHaveLength(0);
  }, 120000);

  it('tx reader (rollback): позиция чтения не продвигается, сообщение читается повторно', async () => {
    const path = await provision('reader_rollback', 'reader_rollback_consumer');
    const results = await createResultsTable('reader_rollback_results');
    const topics = createTopicClient(ctx.driver);
    await seedMessage(path, 'reader_message_2', 'reader_rollback_seed');

    let firstSeqNo: bigint | undefined;
    // First transaction: read the message, write the result, then fail.
    const thrown = await manager
      .runInTransaction(async (trx) => {
        const nativeTx = getNativeTransaction(trx);
        const reader = topics.createTxReader(nativeTx, {
          topic: path,
          consumer: 'reader_rollback_consumer',
        });
        const messages = await readOneTx(reader);
        expect(messages).toHaveLength(1);
        firstSeqNo = messages[0].seqNo;
        expect(payload(messages[0])).toBe('reader_message_2');
        await trx`UPSERT INTO ${identifier(results)} (id) VALUES (${`processed_${messages[0].seqNo}`})`;
        throw new Error('intentional rollback');
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assertTransactionFailedWith(thrown, 'intentional rollback');
    expect(await countRows(results, `processed_${firstSeqNo}`)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, ROLLBACK_SETTLE_MS));

    // Second transaction with a NEW tx reader on the SAME consumer: the
    // position was NOT advanced by the rolled-back attempt, so the same
    // message is delivered again (same seqNo, same content).
    let retriedSeqNo: bigint | undefined;
    await manager.runInTransaction(async (trx) => {
      const nativeTx = getNativeTransaction(trx);
      const reader = topics.createTxReader(nativeTx, {
        topic: path,
        consumer: 'reader_rollback_consumer',
      });
      const messages = await readOneTx(reader);
      expect(messages).toHaveLength(1);
      retriedSeqNo = messages[0].seqNo;
      expect(payload(messages[0])).toBe('reader_message_2');
      await trx`UPSERT INTO ${identifier(results)} (id) VALUES (${`processed_${messages[0].seqNo}`})`;
    });
    expect(firstSeqNo).toBe(1n);
    expect(retriedSeqNo).toBe(firstSeqNo);
    expect(await countRows(results, `processed_${firstSeqNo}`)).toBe(1);

    // Now the position is committed: nothing is redelivered.
    const redelivered = await readOrdinary(path, 'reader_rollback_consumer', 5);
    expect(redelivered).toHaveLength(0);
  }, 120000);
});
