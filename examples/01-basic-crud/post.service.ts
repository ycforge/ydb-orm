/**
 * Сервис примера 1: базовый CRUD через Active Record (статический API
 * сущности) и транзакции через YdbTransactionManager.
 */
import { Injectable } from '@nestjs/common';
import { YdbTransactionManager } from '../../src/index.js';
import type { YdbExecutor, QueryOptions } from '../../src/index.js';
import { PostEntity } from '../entities/index.js';

@Injectable()
export class PostService {
  constructor(private readonly trxManager: YdbTransactionManager) {}

  /** Прямой CRUD через Active Record (статический API сущности). */
  async createAndRead(): Promise<void> {
    // save(): без uuid — INSERT (uuid присваивается автоматически).
    const post = new PostEntity();
    post.title = 'Привет, YDB';
    post.content = 'Первый пост';
    post.user_uuid = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';
    await PostEntity.save(post);
    console.log('Создан пост с uuid:', post.uuid);

    // find(): строго один объект или null (LIMIT 1). Нужно WHERE-условие.
    const found = await PostEntity.find({ uuid: post.uuid });
    console.log('Найден пост:', found?.title);

    // findAll(): список, по умолчанию до 100 строк (макс 1000).
    const all = await PostEntity.findAll({ user_uuid: post.user_uuid });
    console.log('Всего постов пользователя:', all.length);

    // count(): количество строк.
    const total = await PostEntity.count({ user_uuid: post.user_uuid });
    console.log('count:', total);

    // save() с uuid — UPDATE (RETURNING *). Если строки нет — ошибка.
    post.title = 'Обновлённый заголовок';
    const updated = await PostEntity.save(post);
    console.log('Обновлённый title:', updated.title);
  }

  /** Массовая вставка батчами по 100 строк. */
  async bulkInsert(): Promise<void> {
    const posts = Array.from({ length: 3 }, () => {
      const p = new PostEntity();
      p.title = 'Пост';
      p.user_uuid = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';
      return p;
    });
    await PostEntity.insertMany(posts);
    console.log('Вставлено постов:', posts.length);
  }

  /**
   * Транзакция: внутри fn доступен executor, который передаётся
   * во все методы сущностей через { trx } в QueryOptions.
   */
  async transactional(): Promise<void> {
    await this.trxManager.runInTransaction(async (trx: YdbExecutor) => {
      const opts: QueryOptions = { trx };

      const a = new PostEntity();
      a.title = 'A';
      a.user_uuid = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';

      const b = new PostEntity();
      b.title = 'B';
      b.user_uuid = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';

      // Обе вставки выполнятся атомарно: либо обе, либо ни одной.
      await PostEntity.save(a, opts);
      await PostEntity.save(b, opts);

      const count = await PostEntity.count({}, opts);
      console.log('Постов в транзакции:', count);
    });
  }
}
