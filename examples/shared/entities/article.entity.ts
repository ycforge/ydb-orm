/**
 * Статья — демонстрация вторичных индексов (@YdbIndex).
 *
 *  - первый индекс — на `slug`, имя генерируется автоматически;
 *  - второй — составной на (author, created_at), имя задано явно.
 *
 * Индексы создаются schema sync'ом (примеры 08 и 11) и проверяются
 * в schema verify / миграциях.
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbIndex,
  YdbBaseEntity,
} from '../../../src/index.js';

@YdbEntity('articles')
@YdbIndex({ columns: ['slug'] })
@YdbIndex({
  columns: ['author', 'created_at'],
  name: 'articles__author_date',
})
export class ArticleEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  slug: string;

  @YdbColumn('Utf8')
  title: string;

  @YdbColumn('Utf8')
  author: string;

  @YdbColumn('Utf8')
  body: string;

  @YdbColumn('Datetime')
  created_at: Date;
}
