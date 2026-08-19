import { Base64TestEncryptionProvider } from './base64-test-encryption.provider.js';
import type { YdbEncryptionContext } from './ydb-encryption-provider.interface.js';

const context: YdbEncryptionContext = {
  entityName: 'TestEntity',
  tableName: 'test',
  fieldName: 'email',
  primaryKeyValue: 'some-uuid',
  aadFields: {},
};

describe('Base64TestEncryptionProvider', () => {
  const provider = new Base64TestEncryptionProvider();

  describe('encrypt', () => {
    it('returns plaintext bytes as ciphertext', async () => {
      const result = await provider.encrypt('hello world', '', context);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(new TextEncoder().encode('hello world'));
    });

    it('handles empty string', async () => {
      const result = await provider.encrypt('', '', context);
      expect(result).toEqual(new Uint8Array(0));
    });

    it('handles unicode', async () => {
      const result = await provider.encrypt('Привет 🌍', '', context);
      expect(result).toEqual(new TextEncoder().encode('Привет 🌍'));
    });
  });

  describe('decrypt', () => {
    it('decodes ciphertext bytes to plaintext', async () => {
      const ciphertext = new TextEncoder().encode('hello world');
      const result = await provider.decrypt(ciphertext, '', context);
      expect(result).toBe('hello world');
    });

    it('roundtrips unicode', async () => {
      const plaintext = 'Привет 🌍';
      const ciphertext = await provider.encrypt(plaintext, '', context);
      const decrypted = await provider.decrypt(ciphertext, '', context);
      expect(decrypted).toBe(plaintext);
    });

    it('handles empty ciphertext', async () => {
      const result = await provider.decrypt(new Uint8Array(0), '', context);
      expect(result).toBe('');
    });
  });

  describe('hash (blind index)', () => {
    it('produces a deterministic hash from plaintext', async () => {
      const h1 = await provider.hash('test@example.com', context);
      const h2 = await provider.hash('test@example.com', context);
      expect(h1).toBe(h2);
      expect(typeof h1).toBe('string');
      expect(h1.length).toBeGreaterThan(0);
    });

    it('produces different hashes for different inputs', async () => {
      const h1 = await provider.hash('a@test.com', context);
      const h2 = await provider.hash('b@test.com', context);
      expect(h1).not.toBe(h2);
    });

    it('is deterministic regardless of context', async () => {
      const ctx2: YdbEncryptionContext = {
        entityName: 'Other',
        tableName: 'other',
        fieldName: 'other',
        aadFields: {},
      };
      const h1 = await provider.hash('value', context);
      const h2 = await provider.hash('value', ctx2);
      expect(h1).toBe(h2);
    });
  });
});
