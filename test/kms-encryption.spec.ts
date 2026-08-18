import 'reflect-metadata';
import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import type { YdbEncryptionContext } from '../src/encryption/ydb-encryption-provider.interface.js';
import {
  KmsEncryptionProvider,
  KmsBlindIndexProvider,
} from '../src/encryption/kms-encryption.provider.js';

/**
 * Мок KMS-клиента.
 * Тестируем loadKmsClient через prototype-мок, чтобы не ходить в @ycforge/kms.
 */
const mockEncryptResult = {
  ciphertext: new Uint8Array([1, 2, 3, 4, 5]),
};
const mockDecryptResult = {
  plaintext: new TextEncoder().encode('hello world'),
};

const mockKmsClient = {
  encrypt: jest
    .fn<() => Promise<typeof mockEncryptResult>>()
    .mockResolvedValue(mockEncryptResult),
  decrypt: jest
    .fn<() => Promise<typeof mockDecryptResult>>()
    .mockResolvedValue(mockDecryptResult),
};

const context: YdbEncryptionContext = {
  entityName: 'TestEntity',
  tableName: 'test',
  fieldName: 'email',
  primaryKeyValue: 'some-uuid',
  aadFields: {},
};

describe('KmsEncryptionProvider', () => {
  let loadSpy: any;

  beforeEach(() => {
    jest.clearAllMocks();
    loadSpy = jest
      .spyOn(KmsEncryptionProvider.prototype as any, 'loadKmsClient')
      .mockResolvedValue(mockKmsClient);
  });

  afterEach(() => {
    loadSpy.mockRestore();
  });

  it('encrypts and calls KMS client', async () => {
    const provider = new KmsEncryptionProvider({ keyId: 'test-key-id' });
    const result = await provider.encrypt('hello world', 'aad-value', context);

    expect(result).toBe(Buffer.from([1, 2, 3, 4, 5]).toString('base64'));
    expect(mockKmsClient.encrypt).toHaveBeenCalledTimes(1);
    expect(mockKmsClient.encrypt).toHaveBeenCalledWith({
      keyId: 'test-key-id',
      plaintext: new TextEncoder().encode('hello world'),
      aad: new TextEncoder().encode('aad-value'),
    });
  });

  it('encrypts without AAD when aad is empty', async () => {
    const provider = new KmsEncryptionProvider({ keyId: 'test-key-id' });
    await provider.encrypt('data', '', context);

    expect(mockKmsClient.encrypt).toHaveBeenCalledWith({
      keyId: 'test-key-id',
      plaintext: new TextEncoder().encode('data'),
    });
  });

  it('decrypts and calls KMS client', async () => {
    const provider = new KmsEncryptionProvider({ keyId: 'test-key-id' });
    const ciphertext = Buffer.from([1, 2, 3, 4, 5]).toString('base64');
    const result = await provider.decrypt(ciphertext, 'aad-value', context);

    expect(result).toBe('hello world');
    expect(mockKmsClient.decrypt).toHaveBeenCalledTimes(1);
    expect(mockKmsClient.decrypt).toHaveBeenCalledWith({
      ciphertext: new Uint8Array([1, 2, 3, 4, 5]),
      aad: new TextEncoder().encode('aad-value'),
    });
  });

  it('decrypts without AAD when aad is empty', async () => {
    const provider = new KmsEncryptionProvider({ keyId: 'test-key-id' });
    const ciphertext = Buffer.from([10, 20]).toString('base64');
    await provider.decrypt(ciphertext, '', context);

    expect(mockKmsClient.decrypt).toHaveBeenCalledWith({
      ciphertext: new Uint8Array([10, 20]),
    });
  });

  it('roundtrips encrypt/decrypt', async () => {
    const provider = new KmsEncryptionProvider({ keyId: 'test-key-id' });

    const plaintext = 'Привет мир!';
    const encoded = new TextEncoder().encode(plaintext);
    const fakeCiphertext = new Uint8Array([99, 100, 101]);

    mockKmsClient.encrypt.mockResolvedValueOnce({ ciphertext: fakeCiphertext });
    mockKmsClient.decrypt.mockResolvedValueOnce({ plaintext: encoded });

    const ciphertext = await provider.encrypt(plaintext, 'aad', context);
    const decrypted = await provider.decrypt(ciphertext, 'aad', context);

    expect(decrypted).toBe(plaintext);
  });

  it('throws when @ycforge/kms is not installed', async () => {
    loadSpy.mockRejectedValueOnce(
      new Error(
        '@ycforge/kms must be installed for KmsEncryptionProvider: npm install @ycforge/kms',
      ),
    );

    const provider = new KmsEncryptionProvider({ keyId: 'key-1' });
    await expect(provider.encrypt('data', 'aad', context)).rejects.toThrow(
      /@ycforge\/kms must be installed/,
    );
  });
});

describe('KmsBlindIndexProvider', () => {
  it('produces a deterministic SHA-256 hash', async () => {
    const provider = new KmsBlindIndexProvider();
    const h1 = await provider.hash('test@example.com', context);
    const h2 = await provider.hash('test@example.com', context);

    expect(h1).toBe(h2);
    expect(h1).toBe(
      createHash('sha256')
        .update('test@example.com', 'utf8')
        .digest('hex')
        .slice(0, 16),
    );
  });

  it('produces different hashes for different inputs', async () => {
    const provider = new KmsBlindIndexProvider();
    const h1 = await provider.hash('a@test.com', context);
    const h2 = await provider.hash('b@test.com', context);

    expect(h1).not.toBe(h2);
  });

  it('hash length is 16 hex characters', async () => {
    const provider = new KmsBlindIndexProvider();
    const hash = await provider.hash('value', context);

    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
  });
});
