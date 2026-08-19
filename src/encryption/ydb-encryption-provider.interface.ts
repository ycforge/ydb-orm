export interface YdbEncryptionContext {
  entityName: string;
  tableName: string;
  fieldName: string;
  primaryKeyValue?: string;
  aadFields: Record<string, string>;
}

export interface YdbEncryptionProvider {
  /**
   * Шифрует plaintext и возвращает raw ciphertext (Uint8Array).
   * Значение хранится в YDB-колонке `Bytes` (без base64-кодирования).
   */
  encrypt(
    plaintext: string,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<Uint8Array>;
  /**
   * Дешифрует ciphertext (Uint8Array из колонки `Bytes`) и возвращает plaintext.
   */
  decrypt(
    ciphertext: Uint8Array,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<string>;
}

export interface YdbBlindIndexProvider {
  hash(plaintext: string, context: YdbEncryptionContext): Promise<string>;
}
