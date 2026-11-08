/**
 * Context describing where encryption/decryption is being applied. Helps a
 * key-management provider derive or select per-field keys.
 */
export interface YdbEncryptionContext {
  entityName: string;
  tableName: string;
  fieldName: string;
  /** Canonical complete PK tuple for encrypt/decrypt; absent for blind-index queries. */
  primaryKeyValue?: string;
  aadFields: Record<string, string>;
}

export interface YdbEncryptionProvider {
  /**
   * Encrypts the plaintext and returns the raw ciphertext (Uint8Array).
   * The value is stored in a YDB `Bytes` column (no base64 encoding).
   */
  encrypt(
    plaintext: string,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<Uint8Array>;
  /**
   * Decrypts the ciphertext (Uint8Array read from a `Bytes` column) and
   * returns the plaintext.
   */
  decrypt(
    ciphertext: Uint8Array,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<string>;
}

/**
 * Computes a deterministic hash over the plaintext for a blind index,
 * allowing equality lookups without exposing the value. Hash domains must
 * include tableName and fieldName, but must not depend on primaryKeyValue:
 * the same value must be searchable without knowing a record's PK.
 */
export interface YdbBlindIndexProvider {
  hash(plaintext: string, context: YdbEncryptionContext): Promise<string>;
}
