/**
 * Пример 06: шифрование полей.
 *
 * Модель EncryptedUserEntity (examples/shared/entities):
 *   - email        @YdbEncrypted({ blindIndex: true })  — шифруется AES-GCM,
 *                    поиск по blind index (hash-колонка {field}_bi);
 *   - government_id @YdbEncrypted({ blindIndex: false }) — шифруется,
 *                    поиск БЕЗ blind index невозможен по дизайну;
 *   - secret_note  @YdbEncrypted({ lazy: true })        — дешифруется только
 *                    явно (decryptLazyFields) и не попадает в toJSON.
 *
 * Структура таблицы (см. подключение):
 *   encrypted_users(uuid, name, email, email_bi, government_id, secret_note)
 *
 * Ключи шифрования задаются env:
 *   YDB_ORM_ENC_KEY / YDB_ORM_BI_KEY  (base64 от 32 байт)
 * setup.ts читает их и создаёт провайдеры (см. shared/providers).
 */
import { getOrCreateRepository } from '../../src/index.js';
import { EncryptedUserEntity } from '../shared/entities/index.js';
import { connectToYdb } from '../shared/setup.js';

async function main(): Promise<void> {
  const { driver } = await connectToYdb([EncryptedUserEntity], {
    encryption: true, // включает AES-GCM провайдеров из env-ключей
  });

  try {
    const svc = getOrCreateRepository(EncryptedUserEntity);

    // --- Запись: поля шифруются на лету, в БД лежит шифртекст ---
    const user = new EncryptedUserEntity();
    user.name = 'Павел';
    user.email = 'pavel@example.com';
    user.government_id = '1234-567890';
    user.secret_note = 'любит кофе с молоком';
    await svc.save(user);

    const raw = await svc.find({ uuid: user.uuid });
    console.log('Данные после чтения (расшифрованы, кроме lazy):', {
      name: raw?.name,
      email: raw?.email,
      government_id: raw?.government_id,
      secret_note: raw?.secret_note, // lazy-поле: в свойстве лежит шифртекст
    });

    // --- Поиск по blind index: email ИЩЕТСЯ, несмотря на шифрование ---
    const byEmail = await svc.findAll({ email: 'pavel@example.com' });
    console.log('Найден по email (blind index):', byEmail.length);

    // --- Поиск по полю БЕЗ blind index бросит ошибку ---
    try {
      await svc.findAll({ government_id: '1234-567890' });
      console.log('government_id: поиск (неожиданно) прошёл');
    } catch (error) {
      console.log('government_id: поиск запрещён ->', (error as Error).message);
    }

    // --- Lazy-дешифровка: явный вызов decryptLazyFields() (все lazy-поля) ---
    const copy = await svc.find({ uuid: user.uuid });
    console.log('lazy-поле до дешифровки:', copy?.secret_note);
    await copy?.decryptLazyFields();
    console.log('lazy-поле после дешифровки:', copy?.secret_note);

    // --- toJSON() скрывает не дешифрованное lazy-поле, пока его не раскрыли ---
    const json = copy?.toJSON();
    console.log('toJSON раскрывает lazy после дешифровки:', json?.secret_note);

    // --- Обновление и удаление ---
    user.name = 'Павел (обновлён)';
    await svc.save(user);
    await svc.deleteBy({ uuid: user.uuid });
    console.log('Осталось пользователей:', await svc.count({}));
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
