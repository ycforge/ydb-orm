/**
 * Точка входа примера 2 (relations).
 * Как запустить — см. 01-basic-crud/main.ts.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { RelationsService } from './relations.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();

  const service = app.get(RelationsService);
  await service.seed();
  await service.eager();
  await service.queryByForeignKey();

  await app.close();
}

void bootstrap();
