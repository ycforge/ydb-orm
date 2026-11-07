/**
 * Пример 12: топики YDB.
 *
 * YdbTopics работает с СУЩЕСТВУЮЩИМИ топиками и consumers: создание этих
 * объектов в API не входит. Перед запуском создайте их, например через ydb
 * CLI против локального Docker YDB:
 *
 *   ydb -e grpc://localhost:2136/local topic create /local/news --consumers name=processor
 *   ydb -e grpc://localhost:2136/local topic create /local/processed --consumers name=processor
 *
 * Показано:
 *  - публикация: строка в таблице + событие в топике одной транзакцией;
 *  - обработка: смещение входного топика + запись в таблицу + событие
 *    выходного топика одним commit (ambient);
 *  - транзакционные reader/writer создаются в каждой попытке заново,
 *    закрывает их SDK (ручного close у фасадов нет).
 */
import {
  YdbBaseEntity,
  YdbColumn,
  YdbEntity,
  YdbPrimaryColumn,
  YdbTopics,
  YdbTransactionManager,
} from '../../src/index.js';
import { connectToYdb } from '../shared/setup.js';

const NEWS_TOPIC = '/local/news';
const PROCESSED_TOPIC = '/local/processed';
const CONSUMER = 'processor';

@YdbEntity('news')
class NewsEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  title: string;
}

@YdbEntity('processed_news')
class ProcessedNewsEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  id!: string;
}

async function main(): Promise<void> {
  const { driver, executor } = await connectToYdb([
    NewsEntity,
    ProcessedNewsEntity,
  ]);
  const topics = new YdbTopics(driver);
  const tx = new YdbTransactionManager(executor);
  const processedIds: string[] = [];

  try {
    // --- Публикация: таблица + событие одним commit ---
    const news = new NewsEntity();
    news.title = 'ORM поддерживает топики';
    await tx.runInTransaction(
      async (trx) => {
        await NewsEntity.save(news, { trx });
        const writer = topics.createWriter(
          { topic: NEWS_TOPIC, producer: 'news-publisher' },
          { trx },
        );
        writer.write(
          new TextEncoder().encode(
            JSON.stringify({ id: news.uuid, title: news.title }),
          ),
        );
        // Flush перед commit дождётся SDK; вручную закрывать этот writer нельзя.
      },
      { idempotent: false },
    );
    console.log('Новость сохранена и опубликована:', news.uuid);

    // --- Обработка: offset входа + таблица + выход одним commit ---
    await tx.runInTransaction(
      async (trx, attemptSignal) => {
        const reader = topics.createReader(
          { topic: NEWS_TOPIC, consumer: CONSUMER },
          { trx },
        );
        const writer = topics.createWriter(
          { topic: PROCESSED_TOPIC, producer: 'news-processor' },
          { trx },
        );
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
            // Стабильный ключ сообщения — идемпотентность при повторах.
            const id = `${partition.topicPath}:${partition.partitionId}:${message.offset}`;
            const processed = new ProcessedNewsEntity();
            processed.id = id;
            await ProcessedNewsEntity.save(processed, { trx });
            writer.write(message.payload);
            processedIds.push(id);
          }
        }
      },
      { ambient: true, idempotent: false, signal: AbortSignal.timeout(30_000) },
    );
    console.log('Обработано сообщений:', await ProcessedNewsEntity.count());

    // --- Чистка ---
    for (const id of processedIds) await ProcessedNewsEntity.delete(id);
    await NewsEntity.delete(news.uuid);
  } finally {
    await topics.close(); // обычные (нетранзакционные) ресурсы
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
