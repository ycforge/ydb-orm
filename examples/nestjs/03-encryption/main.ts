/**
 * Точка входа NestJS-приложения (пример 03-encryption).
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { UserService } from './user.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const users = app.get(UserService);

    const created = await users.register(
      'Виктор',
      'victor@example.com',
      '9988-776655',
    );
    console.log('Сохранён пользователь:', created.email);

    const found = await users.findByEmail('victor@example.com');
    console.log(
      'Найден по зашифрованному email через blind index:',
      found?.name,
    );

    await users.cleanup(created);
    console.log('Данные очищены');
  } finally {
    await app.close();
  }
}

void bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
