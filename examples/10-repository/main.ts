/**
 * Пример 10: репозитории и EntityManager (DI-вариант поверх Active Record).
 *
 * Active Record даёт статические методы прямо на сущности
 * (UserEntity.save(...)). Репозиторий — альтернативный доступ с тем же
 * поведением: инстанс можно получить заново, он не хранит состояния.
 *
 *   YdbEntityManager.getRepository(Entity) — фабрика репозиториев;
 *   getOrCreateRepository(Entity)         — прямой доступ (используется и
 *                                           Active Record внутри себя).
 */
import { YdbEntityManager, getOrCreateRepository } from '../../src/index.js';
import { PostEntity, UserEntity } from '../shared/entities/index.js';
import { connectToYdb } from '../shared/setup.js';

async function main(): Promise<void> {
  const { driver } = await connectToYdb([UserEntity, PostEntity]);

  try {
    // --- Менеджер сущностей: набор репозиториев на лету ---
    const manager = new YdbEntityManager();
    const users = manager.getRepository(UserEntity);
    const posts = manager.getRepository(PostEntity);

    // --- Сохранение через репозиторий ---
    const user = new UserEntity();
    user.name = 'Никита';
    user.email = 'nikita@example.com';
    user.organization = 'acme';
    await users.save(user);

    const userAgain = await users.find({ uuid: user.uuid });
    console.log('Пользователь через репозиторий:', userAgain?.name);

    // --- find/findAll/count/deleteBy ---
    console.log('Всего пользователей:', await users.count());
    const all = await users.findAll();
    console.log('findAll вернул:', all.length);

    // --- Тот же инстанс, что использует Active Record ---
    const same = getOrCreateRepository(UserEntity);
    const fromActiveRecord = await UserEntity.find({ uuid: user.uuid });
    const fromRepository = await same.find({ uuid: user.uuid });
    console.log(
      'Тот же результат (Active Record === Repository):',
      fromActiveRecord?.name === fromRepository?.name,
    );

    const post = new PostEntity();
    post.title = 'Пост через репозиторий';
    post.content = 'текст';
    post.views = 7;
    post.user_uuid = user.uuid;
    await posts.save(post);

    // --- Query Builder из репозитория ---
    const hotPosts = await posts
      .query()
      .where({ views: 7 })
      .orderBy('views', 'DESC')
      .getMany();
    console.log('Горячий пост:', hotPosts[0]?.title);

    // --- Чистим (deleteBy с условием; поле пользователя известно) ---
    await posts.deleteBy({ user_uuid: user.uuid });
    await users.delete(user.uuid);
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
