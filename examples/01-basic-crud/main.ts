/**
 * Точка входа примера 1 (базовый CRUD).
 *
 * Как запустить против реальной YDB:
 *   1) Задайте переменные окружения для шифрования:
 *        export YDB_ORM_ENC_KEY=$(openssl rand -base64 32)
 *        export YDB_ORM_BI_KEY=$(openssl rand -base64 32)
 *   2) Укажите endpoint и тип авторизации в app.module.ts.
 *   3) Выполните: yarn tsx examples/01-basic-crud/main.ts
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { PostService } from './post.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();

  const service = app.get(PostService);
  await service.createAndRead();
  await service.bulkInsert();
  await service.transactional();

  await app.close();
}

void bootstrap();
