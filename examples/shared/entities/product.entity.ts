/**
 * Товар — демонстрация JSON-колонок (@YdbJson): значение сериализуется
 * в строку Utf8 внутри ORM. Можно хранить произвольные вложенные данные
 * (метаданные, настройки), не заводя отдельную колонку.
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbJson,
  YdbBaseEntity,
} from '../../../src/index.js';

@YdbEntity('products')
export class ProductEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbColumn('Double')
  price: number;

  @YdbColumn('Int32')
  stock: number;

  /** JSON-объект сериализуется в колонку `attributes` (Utf8). */
  @YdbJson()
  @YdbColumn('Utf8')
  attributes: { color: string; size?: string; tags?: string[] };
}
