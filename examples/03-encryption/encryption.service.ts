/**
 * Сервис примера 3: шифрование полей.
 *
 * Модель (см. папку ../entities):
 *  - UserEntity.email          — @YdbEncrypted({ blindIndex: true }): в БД
 *    хранится ciphertext + колонка email_bi (детерминированный hash).
 *    По такому полю можно искать: find/findAll захеширует значение.
 *  - UserEntity.government_id  — @YdbEncrypted({ blindIndex: false }):
 *    только ciphertext, поиск по нему невозможен (и ORM бросит ошибку).
 *  - UserEntity.uuid           — @YdbSecurityAAD(): первичный ключ,
 *    участвует в AAD. @YdbSecurityAAD разрешён только на PK-колонках.
 *
 * Шифрование выполняется провайдером AES-256-GCM + HMAC-SHA256
 * (../providers/aes-gcm-encryption.provider.ts), подключённым в опциях модуля.
 */
import { Injectable } from '@nestjs/common';
import { UserEntity } from '../entities/index.js';

@Injectable()
export class EncryptionService {
  async demo(): Promise<void> {
    // ВАЖНО: в объекте сущности хранится plaintext. ORM шифрует значения
    // в копии перед UPSERT, исходный объект не мутируется (иначе повторный
    // save() зашифровал бы ciphertext повторно).
    const user = new UserEntity();
    user.name = 'Иван';
    user.organization = 'acme';
    user.email = 'ivan@example.com';
    user.government_id = '1234567890';

    await UserEntity.save(user);
    console.log('Сохранено в открытом виде:', user);

    // Частичное обновление зашифрованного поля: AAD берётся из where (PK).
    await UserEntity.updateBy(
      { uuid: user.uuid },
      { email: 'new@example.com' },
    );

    // Чтение: ORM расшифровывает поля автоматически.
    const loaded = await UserEntity.find({ uuid: user.uuid });
    console.log('Прочитано (расшифровано):', loaded?.email);

    // Поиск по зашифрованному полю с blind index: сравниваются хэши.
    const byEmail = await UserEntity.findByEmail('ivan@example.com');
    console.log('Найдено по email (blind index):', byEmail?.uuid);

    // Поиск по полю БЕЗ blind index — ошибка.
    try {
      await UserEntity.find({ government_id: '1234567890' });
    } catch (error) {
      console.log('Ожидаемая ошибка:', (error as Error).message);
    }
  }
}
