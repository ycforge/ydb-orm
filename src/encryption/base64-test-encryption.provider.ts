import {
  YdbBlindIndexProvider,
  YdbEncryptionContext,
  YdbEncryptionProvider,
} from './ydb-encryption-provider.interface.js';

/**
 * Тестовый "шифропровайдер", который не шифрует, а возвращает plaintext
 * как есть (raw bytes). Подходит для проверки конвейера шифрования
 * (encrypt → DB → decrypt) без реальной криптографии.
 */
export class Base64TestEncryptionProvider
  implements YdbEncryptionProvider, YdbBlindIndexProvider
{
  encrypt(
    plaintext: string,
    _aad: string,
    _context: YdbEncryptionContext,
  ): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(plaintext));
  }

  decrypt(
    ciphertext: Uint8Array,
    _aad: string,
    _context: YdbEncryptionContext,
  ): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(ciphertext));
  }

  hash(plaintext: string, _context: YdbEncryptionContext): Promise<string> {
    return Promise.resolve(
      Buffer.from(`bi:${plaintext}`, 'utf8').toString('base64'),
    );
  }
}
