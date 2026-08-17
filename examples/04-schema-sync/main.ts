/**
 * Точка входа примера 4 (создание схемы БД).
 * Как запустить — см. 01-basic-crud/main.ts.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { SchemaService } from './schema.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();

  const service = app.get(SchemaService);
  await service.check();
  await service.apply();

  await app.close();
}

void bootstrap();
