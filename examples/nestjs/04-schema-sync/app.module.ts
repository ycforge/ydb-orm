/**
 * NestJS-пример 04: schema sync.
 *
 * sync: true в опциях модуля -> на onApplicationBootstrap YdbCoreModule
 * подстраивает схему (CREATE TABLE / ALTER ADD COLUMN / индексы / TTL).
 * Синхронизатор доступен и для ручной проверки по DI-токену YDB_SCHEMA_SYNC:
 * syncer.verify([...]) вернёт расхождения без изменений схемы.
 */
import { Module } from '@nestjs/common';
import { ArticleEntity, TtlDocEntity } from '../../shared/entities/index.js';
import { buildYdbOptions } from '../../shared/options.js';
import { YdbOrmModule } from '../../../src/nest/index.js';
import { SchemaService } from './schema.service.js';

@Module({
  imports: [
    YdbOrmModule.forRoot({
      useFactory: () => ({
        ...buildYdbOptions(),
        sync: true, // таблицы создаются при старте приложения
      }),
    }),
    YdbOrmModule.forFeature([ArticleEntity, TtlDocEntity]),
  ],
  providers: [SchemaService],
})
export class AppModule {}
