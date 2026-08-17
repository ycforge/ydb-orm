import {
  YdbBlindIndexProvider,
  YdbEncryptionContext,
  YdbEncryptionProvider,
} from './ydb-encryption-provider.interface.js';

/**
 * Тестовый "шифропровайдер", который не шифрует, а просто кодирует
 * значение в base64. Подходит для проверки конвейера шифрования
 * (encrypt → DB → decrypt) без реальной криптографии.
 */
export class Base64TestEncryptionProvider
  implements YdbEncryptionProvider, YdbBlindIndexProvider
{
  encrypt(
    plaintext: string,
    _aad: string,
    _context: YdbEncryptionContext,
  ): Promise<string> {
    return Promise.resolve(Buffer.from(plaintext, 'utf8').toString('base64'));
  }

  decrypt(
    ciphertext: string,
    _aad: string,
    _context: YdbEncryptionContext,
  ): Promise<string> {
    return Promise.resolve(Buffer.from(ciphertext, 'base64').toString('utf8'));
  }

  hash(plaintext: string, _context: YdbEncryptionContext): Promise<string> {
    return Promise.resolve(
      Buffer.from(`bi:${plaintext}`, 'utf8').toString('base64'),
    );
  }
}
