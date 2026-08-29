/**
 * Пример 07: транзакции.
 *
 * YdbTransactionManager.runInTransaction(fn, options) — колбэк получает
 * executor транзакции; внутри методам сущностей передают `{ trx }` в
 * QueryOptions (последний аргумент).
 *
 * Показано:
 *  - базовый коммит/обработка ошибки (авто-rollback);
 *  - вложенные вызовы: по умолчанию запрещены, `{ reuse: true }`
 *    присоединяется к активной транзакции;
 *  - `{ ambient: true }` — операции без явного `{ trx }` попадают в
 *    транзакцию автоматически;
 *  - таймаут на каждую попытку + глобальный signal;
 *  - `retry: true` — ORM повторяет КОЛБЭК целиком по ABORTED/UNAVAILABLE/
 *    OVERLOADED (backoff + jitter); повтор возможен только для
 *    идемпотентного колбэка.
 */
import { YdbTransactionManager } from '../../src/index.js';
import { PostEntity, UserEntity } from '../shared/entities/index.js';
import { connectToYdb } from '../shared/setup.js';

async function main(): Promise<void> {
  const { driver, executor } = await connectToYdb([UserEntity, PostEntity]);
  const tx = new YdbTransactionManager(executor);

  try {
    const user = new UserEntity();
    user.name = 'Ольга';
    user.email = 'olga@example.com';
    user.organization = 'acme';
    await UserEntity.save(user);

    // --- Базовый сценарий: запись постов + автора одним коммитом ---
    await tx.runInTransaction(async (trx) => {
      const post = new PostEntity();
      post.title = 'Пост в транзакции';
      post.content = 'текст';
      post.views = 1;
      post.user_uuid = user.uuid;
      // `{ trx }` — запросы идут на executor транзакции.
      await PostEntity.save(post, { trx });

      post.title = 'Пост после обновления';
      await PostEntity.save(post, { trx });
    });
    const committed = await PostEntity.findBy({ user_uuid: user.uuid });
    console.log('Заполнено в транзакции:', committed?.length);

    // --- Ошибка в колбэке -> автоматический rollback всего блока ---
    let rollbackSeen = false;
    try {
      await tx.runInTransaction(async (trx) => {
        const post = new PostEntity();
        post.title = 'Будет откатано';
        post.content = 'текст';
        post.views = 1;
        post.user_uuid = user.uuid;
        await PostEntity.save(post, { trx });
        throw new Error('break the transaction');
      });
    } catch {
      rollbackSeen = true;
    }
    console.log('Была ошибка (rollback):', rollbackSeen);
    const afterRollback = await PostEntity.findBy({ title: 'Будет откатано' });
    console.log('Откатанных постов не осталось:', afterRollback?.length === 0);

    // --- Вложенные транзакции: reuse: true присоединяется к активной ---
    await tx.runInTransaction(async (trx) => {
      const post = new PostEntity();
      post.title = 'Вложенный пост';
      post.content = 'текст';
      post.views = 1;
      post.user_uuid = user.uuid;
      await PostEntity.save(post, { trx });

      // Внутренний вызов с reuse: true использует ту же транзакцию.
      await tx.runInTransaction(
        async (innerTrx) => {
          const post2 = new PostEntity();
          post2.title = 'Ещё вложенный';
          post2.content = 'текст';
          post2.views = 1;
          post2.user_uuid = user.uuid;
          await PostEntity.save(post2, { trx: innerTrx });
        },
        { reuse: true },
      );
    });
    console.log(
      'Вложенных постов записано:',
      (await PostEntity.findBy({ title: 'Ещё вложенный' }))?.length,
    );

    // --- ambient: true — методы без явного `{ trx }` в транзакцию ---
    await tx.runInTransaction(
      async () => {
        const post = new PostEntity();
        post.title = 'Ambient пост';
        post.content = 'текст';
        post.views = 1;
        post.user_uuid = user.uuid;
        await PostEntity.save(post); // без { trx } — ambient подхватил
      },
      { ambient: true },
    );
    console.log(
      'Ambient-постов записано:',
      (await PostEntity.findBy({ title: 'Ambient пост' }))?.length,
    );

    // --- Таймаут на попытку + глобальный signal (полный дедлайн) ---
    const deadline = AbortSignal.timeout(5000);
    try {
      await tx.runInTransaction(
        async (trx) => {
          const post = new PostEntity();
          post.title = 'С быстрой записью';
          post.content = 'текст';
          post.views = 1;
          post.user_uuid = user.uuid;
          await PostEntity.save(post, { trx });
        },
        { timeout: 2000, signal: deadline }, // таймаут на каждую попытку
      );
      console.log('Транзакция с таймаутом завершилась');
    } catch (error) {
      console.log('Таймаут/signal сработал:', (error as Error).name);
    }

    // --- retry: true — ORM повторяет колбэк целиком с backoff ---
    // Повторы происходят только для retryable-статусов; в этом примере
    // колбэк не падает, поэтому просто показываем конфигурацию.
    let attempts = 0;
    const result = await tx.runInTransaction(
      async (trx) => {
        attempts++;
        const post = new PostEntity();
        post.title = `Попытка ${attempts}`;
        post.content = 'текст';
        post.views = 1;
        post.user_uuid = user.uuid;
        await PostEntity.save(post, { trx });
        return attempts;
      },
      {
        retry: true, // дефолтная политика: ABORTED/UNAVAILABLE/OVERLOADED
        idempotent: true, // повтор возможен, т.к. колбэк ничего не ломает повторно
      },
    );
    console.log('С retry-политикой выполнено попыток:', result);

    // --- Чистка (удаление по конкретным ключам) ---
    await PostEntity.deleteBy({ user_uuid: user.uuid });
    await UserEntity.delete(user.uuid);
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
