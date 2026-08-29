/**
 * Точка входа NestJS-приложения (пример 02-transactions).
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { OrderService } from './order.service.js';
import { OrderEntity, UserEntity } from '../../shared/entities/index.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const orders = app.get(OrderService);

    const created: Array<{ user: UserEntity; order: OrderEntity }> = [];
    created.push(await orders.placeOrder('Алиса', 1000));
    created.push(await orders.placeOrder('Борис', 2500));

    const list = await orders.listOrders();
    console.log(
      'Заказы:',
      list.map((o) => `${o.customer}: ${o.amount}`),
    );

    await orders.cleanup(
      created.map((c) => c.user),
      created.map((c) => c.order),
    );
    console.log('Данные очищены');
  } finally {
    await app.close();
  }
}

void bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
