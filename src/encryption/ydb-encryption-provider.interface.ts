export interface YdbEncryptionContext {
  entityName: string;
  tableName: string;
  fieldName: string;
  primaryKeyValue?: string;
  aadFields: Record<string, string>;
}

export interface YdbEncryptionProvider {
  encrypt(
    plaintext: string,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<string>;
  decrypt(
    ciphertext: string,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<string>;
}

export interface YdbBlindIndexProvider {
  hash(plaintext: string, context: YdbEncryptionContext): Promise<string>;
}
