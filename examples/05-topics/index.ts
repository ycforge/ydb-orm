import { Driver } from '@ydbjs/core';
import {
  createExecutor,
  YdbTopics,
  YdbTransactionManager,
} from '../../src/index.js';

/** Топики и consumer должны быть созданы заранее; драйвером владеет вызывающий код. */
export async function publishNews(driver: Driver, id: string, title: string) {
  const executor = createExecutor(driver, { endpoint: 'unused' });
  await using topics = new YdbTopics(driver);
  const manager = new YdbTransactionManager(executor);
  await manager.runInTransaction(
    async (trx) => {
      await trx`UPSERT INTO news (id, title) VALUES (${id}, ${title})`;
      const writer = topics.createWriter(
        { topic: '/local/news', producer: 'news-publisher' },
        { trx },
      );
      writer.write(new TextEncoder().encode(JSON.stringify({ id, title })));
    },
    { idempotent: false },
  );
}

/** Offset входа, запись в таблицу и событие выхода подтверждаются вместе. */
export async function processNews(driver: Driver, signal: AbortSignal) {
  const executor = createExecutor(driver, { endpoint: 'unused' });
  await using topics = new YdbTopics(driver);
  const manager = new YdbTransactionManager(executor);
  await manager.runInTransaction(
    async (trx, attemptSignal) => {
      const reader = topics.createReader({
        topic: '/local/news',
        consumer: 'processor',
      });
      const writer = topics.createWriter({
        topic: '/local/processed',
        producer: 'news-processor',
      });
      for await (const batch of reader.read({
        limit: 10,
        waitMs: 1000,
        signal: attemptSignal,
      })) {
        for (const message of batch) {
          const partition = message.partitionSession.deref();
          if (!partition || message.offset === undefined) {
            throw new Error(
              'Topic partition session or offset is unavailable.',
            );
          }
          const key = `${partition.topicPath}:${partition.partitionId}:${message.offset}`;
          await trx`UPSERT INTO processed_news (id) VALUES (${key})`;
          writer.write(message.payload);
        }
      }
    },
    { ambient: true, idempotent: false, signal },
  );
}
