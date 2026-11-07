import { beforeAll, afterAll, describe, it, expect } from '@jest/globals';
import { create } from '@bufbuild/protobuf';
import { abortedTransactionError } from '../helpers/ydb-responses.js';
import {
  TopicServiceDefinition,
  CreateTopicRequestSchema,
  DropTopicRequestSchema,
} from '@ydbjs/api/topic';
import {
  createExecutor,
  YdbTopics,
  YdbTransactionManager,
  type YdbExecutor,
  type TopicMessage,
} from '../../src/index.js';
import {
  createE2eContext,
  hasYdbCredentials,
  type E2eContext,
} from './setup.js';

const suite = hasYdbCredentials() ? describe : describe.skip;
suite('YDB Topics: реальные commit/rollback (#265)', () => {
  let ctx: E2eContext;
  let db: YdbExecutor;
  let verificationDb: YdbExecutor;
  let topics: YdbTopics;
  let manager: YdbTransactionManager;
  const prefix = `orm_topics_${Date.now()}`;
  const paths: string[] = [];
  const table = `${prefix}_rows`;
  const sql = (query: string, executor = verificationDb) => {
    const request = executor([query] as unknown as TemplateStringsArray);
    return query.startsWith('SELECT') ? request.idempotent(true) : request;
  };

  beforeAll(async () => {
    ctx = (await createE2eContext())!;
    db = createExecutor(ctx.driver, {
      endpoint: 'unused',
      logQueries: { log: () => undefined },
      retry: true,
    });
    verificationDb = createExecutor(ctx.driver, { endpoint: 'unused' });
    topics = new YdbTopics(ctx.driver);
    manager = new YdbTransactionManager(db);
    await sql(`CREATE TABLE \`${table}\` (id Utf8 NOT NULL, PRIMARY KEY (id))`);
  }, 60000);

  afterAll(async () => {
    if (!ctx) return;
    await topics?.close();
    const client = ctx.driver.createClient(TopicServiceDefinition);
    for (const path of paths)
      await client.dropTopic(create(DropTopicRequestSchema, { path }));
    await sql(`DROP TABLE \`${table}\``);
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

  async function readMessages(path: string): Promise<TopicMessage[]> {
    const reader = topics.createReader({ topic: path, consumer: 'processor' });
    const messages: TopicMessage[] = [];
    try {
      for await (const batch of reader.read({
        limit: 2,
        waitMs: 2000,
        signal: AbortSignal.timeout(10000),
      }))
        messages.push(...batch);
      return messages;
    } finally {
      if ('close' in reader) await reader.close();
    }
  }

  it('вне транзакции offset фиксируется только явным commit(batch)', async () => {
    const path = await provision('manual_commit');
    const writer = topics.createWriter({
      topic: path,
      producer: 'manual_commit',
    });
    writer.write(new TextEncoder().encode('source'));
    await writer.flush();
    if ('close' in writer) await writer.close();
    expect(await readMessages(path)).toHaveLength(1);
    const reader = topics.createReader({ topic: path, consumer: 'processor' });
    try {
      let count = 0;
      for await (const batch of reader.read({
        limit: 1,
        waitMs: 10000,
        signal: AbortSignal.timeout(15000),
      })) {
        count += batch.length;
        if ('commit' in reader) await reader.commit(batch);
      }
      expect(count).toBe(1);
    } finally {
      if ('close' in reader) await reader.close();
    }
    expect(await readMessages(path)).toHaveLength(0);
  }, 60000);

  it('retry создаёт новые ресурсы и не фиксирует offset или публикацию неуспешной попытки', async () => {
    const input = await provision('retry_in');
    const output = await provision('retry_out');
    const seed = topics.createWriter({ topic: input, producer: 'retry_seed' });
    seed.write(new TextEncoder().encode('source'));
    await seed.flush();
    if ('close' in seed) await seed.close();
    let attempts = 0;
    let first: YdbExecutor | undefined;
    await manager.runInTransaction(
      async (trx, signal) => {
        attempts += 1;
        first ??= trx;
        const reader = topics.createReader(
          { topic: input, consumer: 'processor' },
          { trx },
        );
        let count = 0;
        for await (const batch of reader.read({
          limit: 1,
          waitMs: 10000,
          signal,
        }))
          count += batch.length;
        expect(count).toBe(1);
        const writer = topics.createWriter(
          { topic: output, producer: 'retry_result' },
          { trx },
        );
        writer.write(new TextEncoder().encode('result'));
        if (attempts === 1) throw abortedTransactionError();
      },
      {
        retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
        signal: AbortSignal.timeout(30000),
      },
    );
    expect(attempts).toBe(2);
    expect(() =>
      topics.createWriter({ topic: output }, { trx: first }),
    ).toThrow('live transaction');
    expect(await readMessages(output)).toHaveLength(1);
    expect(await readMessages(input)).toHaveLength(0);
  }, 60000);

  for (const scenario of ['table-topic', 'topic-table', 'topic-topic']) {
    for (const rollback of [false, true]) {
      it(`${scenario}: ${rollback ? 'rollback' : 'commit'}`, async () => {
        const name = `${scenario.replaceAll('-', '_')}_${rollback}`;
        const input = await provision(`${name}_in`);
        const output = await provision(`${name}_out`);
        if (scenario !== 'table-topic') {
          const writer = topics.createWriter({ topic: input, producer: name });
          writer.write(new TextEncoder().encode('source'));
          await writer.flush();
          if ('close' in writer) await writer.close();
        }
        const result = manager.runInTransaction(
          async (trx, signal) => {
            if (scenario !== 'table-topic') {
              const reader = topics.createReader(
                { topic: input, consumer: 'processor' },
                { trx },
              );
              let count = 0;
              for await (const batch of reader.read({
                limit: 1,
                waitMs: 10000,
                signal,
              }))
                count += batch.length;
              expect(count).toBe(1);
            }
            if (scenario !== 'topic-topic')
              await sql(
                `UPSERT INTO \`${table}\` (id) VALUES ('${name}')`,
                trx,
              );
            if (scenario !== 'topic-table') {
              // Проверяем ambient вместе с явным trx у reader и SQL.
              const writer = topics.createWriter({
                topic: output,
                producer: `${name}_result`,
              });
              writer.write(new TextEncoder().encode('result'));
            }
            if (rollback) throw new Error('intentional rollback');
          },
          {
            ambient: true,
            idempotent: false,
            signal: AbortSignal.timeout(30000),
          },
        );
        if (rollback) await expect(result).rejects.toThrow();
        else await result;
        if (scenario !== 'topic-topic') {
          const rows = await sql(
            `SELECT id FROM \`${table}\` WHERE id = '${name}'`,
          );
          expect(rows[0]).toHaveLength(rollback ? 0 : 1);
        }
        if (scenario !== 'topic-table')
          expect(await readMessages(output)).toHaveLength(rollback ? 0 : 1);
        if (scenario !== 'table-topic')
          expect(await readMessages(input)).toHaveLength(rollback ? 1 : 0);
      }, 60000);
    }
  }
});
