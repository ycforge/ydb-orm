/**
 * NestJS-пример 02: транзакции через DI.
 *
 * YdbTransactionManager регистрируется модулем глобально; вложенность
 * запрещена по умолчанию, `{ reuse: true }` присоединяется к активной
 * транзакции. Амбиент-режим можно включить глобально в опциях модуля
 * (transactions.ambient) — тогда операции без явного { trx } автоматически
 * попадают в активную транзакцию.
 */
import { Module } from '@nestjs/common';
import { OrderEntity, UserEntity } from '../../shared/entities/index.js';
import { buildYdbOptions } from '../../shared/options.js';
import { YdbOrmModule } from '../../../src/nest/index.js';
import { OrderService } from './order.service.js';

@Module({
  imports: [
    YdbOrmModule.forRoot({
      useFactory: () => ({
        ...buildYdbOptions(),
        sync: true,
        // Глобальный ambient: методы сущностей без { trx } внутри
        // runInTransaction() идут в транзакцию автоматически.
        transactions: { ambient: true },
      }),
    }),
    YdbOrmModule.forFeature([UserEntity, OrderEntity]),
  ],
  providers: [OrderService],
})
export class AppModule {}
