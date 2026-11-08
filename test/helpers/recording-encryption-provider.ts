import type {
  YdbBlindIndexProvider,
  YdbEncryptionContext,
  YdbEncryptionProvider,
} from '../../src/index.js';

/**
 * Test encryption provider that records actual concurrency (#234):
 * `active` is the number of in-flight encrypt() calls, `maxActive` its peak.
 * An optional delay makes overlapping calls observable.
 * encrypt() can also be forced to throw on a specific plaintext to
 * verify pre-processing interruption.
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
