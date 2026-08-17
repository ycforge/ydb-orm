/**
 * Точка входа примера 3 (шифрование полей).
 * Как запустить — см. 01-basic-crud/main.ts (нужны YDB_ORM_ENC_KEY и YDB_ORM_BI_KEY).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { EncryptionService } from './encryption.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();

  await app.get(EncryptionService).demo();
  await app.close();
}

void bootstrap();
