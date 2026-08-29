/**
 * Пример 04: связи (relations).
 *
 * Модель (см. shared/entities и локальные eager-сущности):
 *   User   1 ─── N Post       (Join column: PostEntity.user_uuid)
 *   User   1 ─── 1 Profile    (Join column: UserEntity.profile_uuid)
 *   Post   N ─── M Tag        (join-таблица `post_tags`)
 *   EagerAuthor 1 ─── N EagerPost  + @EagerLoad — подгрузка батчем
 *
 * Показано:
 *  - ручная загрузка через instance.loadRelations([...]);
 *  - many-to-many: запись в join-таблицу + чтение через loadRelations.
 *    ORM не управляет записью в join-таблицу — строки создаются отдельным
 *    INSERT, а чтение relation выполняется ORM за 2 запроса (без N+1);
 *  - eager loading: relations приходят вместе с find/findAll.
 */
import { mapToYdb } from '../../src/index.js';
import {
  UserEntity,
  PostEntity,
  ProfileEntity,
  TagEntity,
} from '../shared/entities/index.js';
import { connectToYdb } from '../shared/setup.js';
import { EagerAuthorEntity } from './eager-author.entity.js';
import { EagerPostEntity } from './eager-post.entity.js';

async function main(): Promise<void> {
  const { driver, executor } = await connectToYdb([
    UserEntity,
    PostEntity,
    ProfileEntity,
    TagEntity,
    EagerAuthorEntity,
    EagerPostEntity,
  ]);

  try {
    // --- Готовим граф: пользователь + профиль + 3 поста + теги ---
    const user = new UserEntity();
    user.name = 'Иван';
    user.email = 'ivan@example.com';
    user.organization = 'acme';
    await UserEntity.save(user);

    const profile = new ProfileEntity();
    profile.bio = 'Разработчик';
    await ProfileEntity.save(profile);
    user.profile_uuid = profile.uuid;
    await UserEntity.save(user); // обновляем FK профиля

    const posts: PostEntity[] = [];
    for (let i = 0; i < 3; i++) {
      const post = new PostEntity();
      post.title = `Пост #${i + 1}`;
      post.content = 'Содержимое';
      post.views = 0;
      post.user_uuid = user.uuid;
      posts.push(post);
    }
    await PostEntity.insertMany(posts);

    // Теги для многих-ко-многим.
    const backend = new TagEntity();
    backend.name = 'backend';
    const frontend = new TagEntity();
    frontend.name = 'frontend';
    await TagEntity.insertMany([backend, frontend]);

    // Строки join-таблицы: posts_uuid / tags_uuid (имена по умолчанию).
    const link = async (postUuid: string, tagUuid: string): Promise<void> => {
      const insert = executor`
        INSERT INTO post_tags (posts_uuid, tags_uuid)
        VALUES ($postUuid, $tagUuid)
      `;
      insert
        .parameter('postUuid', mapToYdb('Uuid', postUuid, 'postUuid'))
        .parameter('tagUuid', mapToYdb('Uuid', tagUuid, 'tagUuid'));
      await insert;
    };
    await link(posts[0].uuid, backend.uuid);
    await link(posts[0].uuid, frontend.uuid);
    await link(posts[1].uuid, backend.uuid);

    // --- 1:N: посты пользователя через loadRelations ---
    const author = await UserEntity.find({ uuid: user.uuid });
    await author!.loadRelations(['posts']);
    console.log(
      'Посты пользователя:',
      author!.posts?.map((p) => p.title),
    );

    // --- N:1: автор поста + M:N теги поста ---
    const post = posts[0];
    await post.loadRelations(['user', 'tags']);
    console.log('Автор поста:', post.user?.name);
    console.log(
      'Теги поста:',
      post.tags?.map((t) => t.name),
    );

    // --- 1:1: профиль пользователя ---
    await author!.loadRelations(['profile']);
    console.log('Профиль пользователя:', author!.profile?.bio);

    // --- 1:N через find по join column ---
    const userPosts = await PostEntity.findAll({ user_uuid: user.uuid });
    console.log('Всего постов пользователя:', userPosts.length);

    // --- Eager loading: @EagerLoad(['posts']) подгружает посты батчем ---
    const eagerAuthor = new EagerAuthorEntity();
    eagerAuthor.name = 'Мария';
    await EagerAuthorEntity.save(eagerAuthor);

    const eagerPosts = Array.from({ length: 2 }, (_, i) => {
      const p = new EagerPostEntity();
      p.title = `Запись ${i + 1}`;
      p.author_uuid = eagerAuthor.uuid;
      return p;
    });
    await EagerPostEntity.insertMany(eagerPosts);

    const loaded = await EagerAuthorEntity.find({ uuid: eagerAuthor.uuid });
    console.log(
      'Eager-посты:',
      loaded?.posts?.map((p) => p.title),
    );

    // --- Чистим за собой (удаление по конкретным ключам) ---
    await executor`DELETE FROM post_tags`;
    for (const p of posts) await PostEntity.delete(p.uuid);
    await UserEntity.delete(user.uuid);
    await ProfileEntity.delete(profile.uuid);
    await TagEntity.delete(backend.uuid);
    await TagEntity.delete(frontend.uuid);
    await EagerPostEntity.deleteBy({ author_uuid: eagerAuthor.uuid });
    await EagerAuthorEntity.delete(eagerAuthor.uuid);
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
