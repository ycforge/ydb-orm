/**
 * Точка входа NestJS-приложения (пример 01-crud).
 *
 * NestFactory.createApplicationContext — без HTTP-слоя: пример лишь
 * выполняет операции с БД и выходит. В реальном приложении используйте
 * NestFactory.create(AppModule) и контроллеры.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { UsersService } from './users.service.js';

async function bootstrap(): Promise<void> {
  // app.init() (внутри createApplicationContext) поднимает провайдеры:
  // подключается YDB, при sync: true создаётся схема.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'], // тише в консоли
  });
  try {
    const users = app.get(UsersService);

    const created = await users.create('Марина', 'marina@example.com');
    console.log('Создан пользователь:', created.uuid);

    const found = await users.findByName('Марина');
    console.log('Найдено пользователей:', found.length);

    await users.cleanup(created);
    console.log('Данные очищены');
  } finally {
    // onApplicationShutdown -> driver.close()
    await app.close();
  }
}

void bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
