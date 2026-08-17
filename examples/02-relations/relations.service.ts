/**
 * Сервис примера 2: relations.
 *
 *  - @EagerLoad(['posts', 'profile']) на UserEntity автоматически подгружает
 *    relations одним батч-запросом `WHERE col IN (...)` при find/findAll
 *    (без N+1).
 *  - instance.loadRelations([...]) подгружает relation вручную.
 *
 * Модель (см. папку ../entities):
 *   User 1 — N Post    (User.posts / Post.user, FK: Post.user_uuid)
 *   User 1 — 1 Profile (User.profile / Profile.user, FK: User.profile_uuid)
 */
import { Injectable } from '@nestjs/common';
import { YdbTransactionManager } from '../../src/index.js';
import type { QueryOptions } from '../../src/index.js';
import { UserEntity, PostEntity, ProfileEntity } from '../entities/index.js';

@Injectable()
export class RelationsService {
  constructor(private readonly trxManager: YdbTransactionManager) {}

  /** Создаёт граф: пользователь + его посты + профиль. */
  async seed(): Promise<void> {
    await this.trxManager.runInTransaction(async (trx) => {
      const opts: QueryOptions = { trx };

      const user = new UserEntity();
      user.name = 'Иван';
      user.organization = 'acme'; // AAD-поле
      user.email = 'ivan@example.com';
      user.government_id = '1234567890';
      await UserEntity.save(user, opts);

      for (let i = 0; i < 2; i++) {
        const post = new PostEntity();
        post.title = `Пост #${i + 1}`;
        post.user_uuid = user.uuid;
        await PostEntity.save(post, opts);
      }

      // Owning-сторона one-to-one: User хранит FK на Profile.
      const profile = new ProfileEntity();
      profile.bio = 'Разработчик';
      await ProfileEntity.save(profile, opts);
      user.profile_uuid = profile.uuid;
      await UserEntity.save(user, opts);

      console.log('Создан пользователь:', user.uuid);
    });
  }

  /** Eager-загрузка: relations приходят вместе с пользователем. */
  async eager(): Promise<void> {
    const user = await UserEntity.findByEmail('ivan@example.com');
    if (!user) return;

    // @EagerLoad(['posts', 'profile']) — уже заполнены без доп. вызовов.
    console.log(
      'Eager posts:',
      user.posts?.map((p) => p.title),
    );
    console.log('Eager profile:', user.profile?.bio);

    // Many-to-one тоже доступен (Post.user) — вручную через loadRelations.
    const post = user.posts?.[0];
    if (post) {
      await post.loadRelations(['user']);
      console.log('Автор поста:', post.user?.name);
    }
  }

  /** Поиск по внешнему ключу + пагинация через QueryOptions. */
  async queryByForeignKey(): Promise<void> {
    const user = await UserEntity.find({ name: 'Иван' });
    if (!user) return;

    // findAll по joinColumn: найдутся посты, чей user_uuid === user.uuid.
    const page = await PostEntity.findAll(
      { user_uuid: user.uuid },
      { limit: 10, offset: 0 },
    );
    console.log('Посты пользователя (пагинация):', page.length);
  }
}
