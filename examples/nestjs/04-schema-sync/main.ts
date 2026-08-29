/**
 * Точка входа NestJS-приложения (пример 04-schema-sync).
 * Таблицы создаются автоматически при bootstrap (sync: true).
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { SchemaService } from './schema.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const schema = app.get(SchemaService);
    const issues = await schema.check();
    console.log('Расхождений схемы после bootstrap:', issues.length);

    if (issues.length) {
      for (const issue of issues) console.log('  -', issue);
    }
  } finally {
    await app.close();
  }
}

void bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
