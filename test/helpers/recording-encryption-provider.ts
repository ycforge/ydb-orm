import type {
  YdbBlindIndexProvider,
  YdbEncryptionContext,
  YdbEncryptionProvider,
} from '../../src/index.js';

/**
 * Тестовый провайдер шифрования, фиксирующий фактическую конкурентность (#234):
 * `active` — число вызовов encrypt() в полёте, `maxActive` — его пик.
 * Опциональная задержка делает перекрытие вызовов наблюдаемым.
 * Также можно заставить encrypt() бросить на конкретном plaintext для
 * проверки прерывания предобработки.
 */
export class RecordingEncryptionProvider
  implements YdbEncryptionProvider, YdbBlindIndexProvider
{
  active = 0;
  maxActive = 0;
  encryptCalls = 0;
  readonly encryptedPlaintexts: string[] = [];

  constructor(
    private readonly delayMs = 0,
    private readonly failOnPlaintext?: string,
  ) {}

  async encrypt(
    plaintext: string,
    _aad: string,
    _context: YdbEncryptionContext,
  ): Promise<Uint8Array> {
    this.encryptCalls++;
    this.encryptedPlaintexts.push(plaintext);
    this.active++;
    if (this.active > this.maxActive) this.maxActive = this.active;
    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (
        this.failOnPlaintext !== undefined &&
        plaintext === this.failOnPlaintext
      ) {
        throw new Error(`recording provider: forced failure on "${plaintext}"`);
      }
      return new TextEncoder().encode(plaintext);
    } finally {
      this.active--;
    }
  }

  decrypt(
    ciphertext: Uint8Array,
    _aad: string,
    _context: YdbEncryptionContext,
  ): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(ciphertext));
  }

  hash(plaintext: string, _context: YdbEncryptionContext): Promise<string> {
    return Promise.resolve(`hash:${plaintext}`);
  }
}
