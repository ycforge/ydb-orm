import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEnum,
} from '../../../src/index.js';

/**
 * Фикстура #109: enum со storage Int32 (порядковый индекс значения в БД).
 * Отдельный файл — чтобы сценарные тесты (insertMany, транзакции, TTL-поток)
 * переиспользовали одну и ту же сущность вместо локальных объявлений.
 */

export enum OrderStatus {
  NEW = 'new',
  PAID = 'paid',
  SHIPPED = 'shipped',
  CANCELLED = 'cancelled',
}

@YdbEntity('fixture_orders')
export class OrderStatusEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  title: string;

  @YdbColumn('Int32')
  @YdbEnum({ values: Object.values(OrderStatus), storage: 'Int32' })
  status: OrderStatus | undefined;
}
