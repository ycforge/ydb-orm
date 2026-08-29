/**
 * Локальная сущность для примера 08-schema-sync:
 * вторичный индекс (GLOBAL SYNC) — попадёт в CREATE TABLE.
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbIndex,
} from '../../src/index.js';

@YdbEntity('demo_items')
@YdbIndex({ columns: ['title'] })
@YdbIndex({
  columns: ['category', 'rating'],
  name: 'demo_items__category_rating',
})
export class DemoItemEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  title: string;

  @YdbColumn('Utf8')
  category: string;

  @YdbColumn('Int32')
  rating: number;
}
