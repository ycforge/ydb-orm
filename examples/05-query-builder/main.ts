/**
 * Пример 05: Query Builder.
 *
 * Переносимый с TypeORM низкоуровневый API поверх метаданных сущности:
 * where/andWhere/orWhere, orderBy/addOrderBy, select, limit/offset,
 * getMany/getOne/getCount, toYql (SQL и параметры без выполнения).
 *
 * Билдер получаем через репозиторий: getOrCreateRepository(Entity).query().
 */
import { getOrCreateRepository, YdbQueryBuilder } from '../../src/index.js';
import { PostEntity } from '../shared/entities/index.js';
import { connectToYdb } from '../shared/setup.js';

async function main(): Promise<void> {
  const { driver } = await connectToYdb([PostEntity]);

  try {
    // Заливаем данные: 5 постов с разным количеством просмотров.
    const posts: PostEntity[] = [];
    for (let i = 1; i <= 5; i++) {
      const post = new PostEntity();
      post.title = i % 2 === 0 ? `Чётный пост ${i}` : `Нечётный пост ${i}`;
      post.content = 'текст';
      post.views = i * 10; // 10, 20, 30, 40, 50
      posts.push(post);
    }
    await PostEntity.insertMany(posts);

    // --- Простой WHERE + LIMIT/OFFSET ---
    const qb = getOrCreateRepository(PostEntity).query();
    const top = await qb
      .where({})
      .orderBy('views', 'DESC')
      .limit(3)
      .offset(0)
      .getMany();
    console.log(
      'Топ-3 по просмотрам:',
      top.map((p) => `${p.title}: ${p.views}`),
    );

    // --- Навешиваем условия и считаем ---
    const count = await qb.where({ views: 40 }).getCount();
    console.log('Постов с views = 40:', count);

    // --- getOne: первый результат; getCount без limit/offset ---
    const single = await qb.where({ views: 30 }).getOne();
    console.log('getOne(views=30):', single?.title);

    // --- toYql: посмотрим SQL и параметры без выполнения ---
    const { sql, values } = await qb
      .select(['title', 'views'])
      .where({})
      .orderBy('views', 'ASC')
      .limit(2)
      .toYql();
    console.log('SQL:', sql);
    console.log('params:', Object.keys(values).length);

    // --- orWhere: A OR B ---
    const orPosts = await qb
      .where({ views: 10 })
      .orWhere({ views: 50 })
      .getMany();
    console.log(
      'views=10 OR views=50:',
      orPosts.map((p) => p.views),
    );

    // --- Строим запрос вручную через билдер-конструктор ---
    // Синтаксически валидный UUID, которого нет в базе: поиск даст 0 строк.
    // Значения в where конвертируются по метаданным колонки автоматически.
    const manual = new YdbQueryBuilder<PostEntity>(PostEntity);
    const byOwner = await manual
      .where({ user_uuid: '00000000-0000-4000-8000-000000000000' })
      .limit(5)
      .getMany();
    console.log('Постов у несуществующего автора:', byOwner.length);

    // --- Чистим за собой (delete по конкретным ключам) ---
    for (const post of posts) await PostEntity.delete(post.uuid);
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
