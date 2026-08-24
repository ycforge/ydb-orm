import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbIndex,
} from '../../../src/index.js';

/**
 * Фикстура #109: вторичные индексы — автоименованный (по таблице и колонке)
 * и явно названный составной.
 */

@YdbEntity('fixture_articles')
@YdbIndex({ columns: ['slug'] })
@YdbIndex({
  columns: ['author', 'created_at'],
  name: 'fixture_articles__author_date',
})
export class IndexedArticleEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  slug: string;

  @YdbColumn('Utf8')
  author: string;

  @YdbColumn('Datetime')
  created_at: Date;
}
