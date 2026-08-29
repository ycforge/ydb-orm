/**
 * Заказ — демонстрация @YdbEnum: enum хранится как Int32 (порядковый
 * номер) либо как Utf8 (имя значения, по умолчанию). Здесь — Int32.
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbEnum,
  YdbBaseEntity,
} from '../../../src/index.js';

export enum OrderStatus {
  NEW = 'new',
  PAID = 'paid',
  SHIPPED = 'shipped',
  CANCELLED = 'cancelled',
}

@YdbEntity('orders')
export class OrderEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  customer: string;

  /** Int32 enum: в БД хранится ordinal, в объекте — значение enum'а. */
  @YdbColumn('Int32')
  @YdbEnum({ values: Object.values(OrderStatus), storage: 'Int32' })
  status: OrderStatus;

  @YdbColumn('Double')
  amount: number;

  @YdbColumn('Datetime')
  placed_at: Date;
}
