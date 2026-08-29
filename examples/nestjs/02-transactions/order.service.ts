/**
 * Сервис заказов: транзакции через YdbTransactionManager (по DI).
 */
import { Injectable, Inject } from '@nestjs/common';
import {
  InjectRepository,
  YdbRepository,
  YdbTransactionManager,
} from '../../../src/nest/index.js';
import {
  OrderEntity,
  OrderStatus,
  UserEntity,
} from '../../shared/entities/index.js';

@Injectable()
export class OrderService {
  constructor(
    @Inject(YdbTransactionManager)
    private readonly tx: YdbTransactionManager,
    @InjectRepository(UserEntity)
    private readonly users: YdbRepository<UserEntity>,
    @InjectRepository(OrderEntity)
    private readonly orders: YdbRepository<OrderEntity>,
  ) {}

  /** Создаёт заказ и обновляет пользователя в одной транзакции. */
  async placeOrder(
    userName: string,
    amount: number,
  ): Promise<{ user: UserEntity; order: OrderEntity }> {
    const result = await this.tx.runInTransaction(async (trx) => {
      // ambient: true в настройках модуля — можно не передавать { trx } явно.
      const user = new UserEntity();
      user.name = userName;
      user.email = `${userName}@example.com`;
      user.organization = 'acme';
      await this.users.save(user);

      const order = new OrderEntity();
      order.customer = userName;
      order.amount = amount;
      order.status = OrderStatus.NEW;
      order.placed_at = new Date();
      await this.orders.save(order, { trx });
      return { user, order };
    });
    return result;
  }

  async listOrders(): Promise<OrderEntity[]> {
    return this.orders.findAll({});
  }

  async cleanup(users: UserEntity[], orders: OrderEntity[]): Promise<void> {
    for (const order of orders) await this.orders.delete(order.uuid);
    for (const user of users) await this.users.delete(user.uuid);
  }
}
