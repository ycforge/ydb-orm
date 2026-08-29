/**
 * Пример 01: максимально простой сценарий.
 *
 * Подключаемся к YDB, создаём таблицу `users`, сохраняем пользователя
 * и читаем его обратно. Без фреймворков и DI — чистый Active Record.
 *
 * Запуск:
 *   yarn build
 *   yarn examples:build
 *   node dist-examples/examples/01-users/main.js
 */
import { UserEntity } from '../shared/entities/index.js';
import { connectToYdb } from '../shared/setup.js';

async function main(): Promise<void> {
  // Подключение + configureEntities([UserEntity]) + создание таблицы.
  const { driver } = await connectToYdb([UserEntity]);

  try {
    // 1. Создание: save() без PK — INSERT (uuid генерируется автоматически).
    const user = new UserEntity();
    user.name = 'Иван';
    user.email = 'ivan@example.com';
    user.organization = 'acme';
    await UserEntity.save(user);

    console.log('Создан пользователь:', user.uuid);

    // 2. Чтение одной записи по PK: find() отдаёт сущность или null.
    const found = await UserEntity.find({ uuid: user.uuid });
    console.log('Найден пользователь:', found?.name, found?.email);

    // 3. Обновление: save() с PK — UPDATE (RETURNING *).
    user.name = 'Иван Обновлённый';
    const updated = await UserEntity.save(user);
    console.log('Обновлённое имя:', updated.name);

    // 4. Чистим за собой, чтобы пример можно было запускать повторно.
    await UserEntity.delete(user.uuid);
    console.log('Пользователь удалён');
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
