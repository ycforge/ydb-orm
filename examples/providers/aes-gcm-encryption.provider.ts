/**
 * Реальный криптопровайдер для ydb-orm: AES-256-GCM (шифрование полей) +
 * HMAC-SHA256 (blind index). Реализует интерфейсы YdbEncryptionProvider
 * и YdbBlindIndexProvider. Подключается через опции модуля:
 *
 *   encryptionProvider: provider,
 *   blindIndexProvider: provider,
 *
 * Ключи передаются через переменные окружения (НЕ хардкодьте их в коде
 * и не коммитьте в репозиторий).
 *
 * AAD (Additional Authenticated Data) привязывает ciphertext к значениям
 * @YdbSecurityAAD-полей сущности: если злоумышленник изменит такое поле,
 * расшифровка упадёт.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import {
  YdbEncryptionProvider,
  YdbBlindIndexProvider,
  YdbEncryptionContext,
} from '../../src/index.js';

export class AesGcmEncryptionProvider
  implements YdbEncryptionProvider, YdbBlindIndexProvider
{
  private readonly key: Buffer;
  private readonly hmacKey: Buffer;

  constructor(encryptionKey: string, blindIndexKey: string) {
    this.key = Buffer.from(encryptionKey, 'base64');
    this.hmacKey = Buffer.from(blindIndexKey, 'base64');
  }

  /** Шифрует поле: IV (12) + auth tag (16) + ciphertext, всё — в base64. */
  encrypt(
    plaintext: string,
    aad: string,
    _context: YdbEncryptionContext,
  ): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Promise.resolve(
      Buffer.concat([iv, tag, encrypted]).toString('base64'),
    );
  }

  decrypt(
    ciphertext: string,
    aad: string,
    _context: YdbEncryptionContext,
  ): Promise<string> {
    const data = Buffer.from(ciphertext, 'base64');
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Promise.resolve(
      Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
        'utf8',
      ),
    );
  }

  /** Детерминированный hash для blind index (поиск по зашифрованному полю). */
  hash(plaintext: string, _context: YdbEncryptionContext): Promise<string> {
    return Promise.resolve(
      createHmac('sha256', this.hmacKey).update(plaintext).digest('base64'),
    );
  }
}

/** Фабрика провайдера из переменных окружения. */
export function createEncryptionProvider(): AesGcmEncryptionProvider {
  const key = process.env.YDB_ORM_ENC_KEY;
  const biKey = process.env.YDB_ORM_BI_KEY;
  if (!key || !biKey) {
    throw new Error(
      'Set YDB_ORM_ENC_KEY and YDB_ORM_BI_KEY (base64, 32 bytes each)',
    );
  }
  return new AesGcmEncryptionProvider(key, biKey);
}
