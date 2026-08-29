/**
 * Пример 08: schema sync (аналог `synchronize` в TypeORM).
 *
 * YdbSchemaSyncer(driver, executor):
 *  - verify(entities) — проверяет схему БД против метаданных, ничего не меняет;
 *  - sync(entities)   — создаёт недостающие таблицы (CREATE TABLE), колонки
 *    (ALTER TABLE ADD COLUMN), индексы и TTL; лишнее только предупреждает;
 *    расхождение типа или PK — ошибка (в YDB нельзя alter'ить).
 *
 * Показано: verify (таблиц нет) -> sync (создание) -> повторный verify (0).
 * join-таблица many-to-many (PostEntity <-> TagEntity) тоже создаётся sync'ом.
 * В продакте schema sync не включайте — используйте миграции (пример 09).
 */
import {
  createDriver,
  createExecutor,
  YdbSchemaSyncer,
} from '../../src/index.js';
import {
  PostEntity,
  TagEntity,
  TtlDocEntity,
} from '../shared/entities/index.js';
import { buildYdbOptions } from '../shared/options.js';
import { DemoItemEntity } from './demo-item.entity.js';

async function main(): Promise<void> {
  const dbOptions = buildYdbOptions();
  const driver = await createDriver(dbOptions);
  try {
    const executor = createExecutor(driver, dbOptions);
    const syncer = new YdbSchemaSyncer(driver, executor);

    const entities = [DemoItemEntity, PostEntity, TagEntity, TtlDocEntity];

    // --- Запускаем БЕЗ синка: смотрим, чего не хватает ---
    const before = await syncer.verify(entities);
    console.log(
      'Расхождения до sync:',
      before.map((issue) => issue.message),
    );

    // --- sync создаёт таблицы/индексы/TTL ---
    await syncer.sync(entities);
    console.log('sync() выполнен');

    const after = await syncer.verify(entities);
    console.log('Расхождения после sync:', after.length);

    // --- Повторный sync идемпотентен ---
    await syncer.sync(entities);
    console.log('повторный sync() не упал');

    // --- TtlDocEntity: sync выставил TTL из @YdbTtl ---
    const ttlCheck = await syncer.verify([TtlDocEntity]);
    console.log('TTL-сущность согласована:', ttlCheck.length === 0);
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
