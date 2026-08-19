import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';

export const YDB_ENTITY_KEY = 'ydb:entity';
export const YDB_COLUMNS_KEY = 'ydb:columns';
export const YDB_PRIMARY_KEYS_KEY = 'ydb:primaryKeys';
export const YDB_ENCRYPTED_KEY = 'ydb:encrypted';
export const YDB_SECURITY_AAD_KEY = 'ydb:security:aad';
export const YDB_JSON_COLUMNS_KEY = 'ydb:jsonColumns';

export interface EncryptedFieldMeta {
  propertyKey: string;
  blindIndex: boolean;
  aadOverride?: string;
  /**
   * Ленивая дешифровка: поле не дешифруется при чтении из БД,
   * а только по явному вызову decryptField()/decryptLazyFields().
   */
  lazy?: boolean;
}

export interface YdbEntityMetadata<T = any> {
  tableName: string;
  schema: Record<string, YdbPrimitive>;
  primaryKeys: string[];
  encryptedFields: EncryptedFieldMeta[];
  aadFields: string[];
  /** Колонки с автоматической JSON-сериализацией (хранятся как Utf8). */
  jsonColumns: string[];
  target: new (...args: any[]) => T;
}

/**
 * Метаданные собираются из Reflect один раз на класс: декораторы
 * отрабатывают при определении класса, до первого запроса.
 */
const metadataCache = new WeakMap<object, YdbEntityMetadata<any>>();

/**
 * Извлекает метаданные, собранные декораторами @YdbEntity / @YdbColumn.
 */
export function getYdbEntityMetadata<T>(
  target: new (...args: any[]) => T,
): YdbEntityMetadata<T> | undefined {
  const cached = metadataCache.get(target);
  if (cached) return cached as YdbEntityMetadata<T>;

  const tableName: string | undefined = Reflect.getMetadata(
    YDB_ENTITY_KEY,
    target,
  );
  const columnsMap: Map<string, YdbPrimitive> | undefined = Reflect.getMetadata(
    YDB_COLUMNS_KEY,
    target,
  );
  const primaryKeys: string[] =
    Reflect.getMetadata(YDB_PRIMARY_KEYS_KEY, target) || [];
  const encryptedFields: EncryptedFieldMeta[] =
    Reflect.getMetadata(YDB_ENCRYPTED_KEY, target) || [];
  const aadFields: string[] = (
    (Reflect.getMetadata(YDB_SECURITY_AAD_KEY, target) || []) as string[]
  )
    .slice()
    .sort();
  const jsonColumns: string[] =
    Reflect.getMetadata(YDB_JSON_COLUMNS_KEY, target) || [];

  if (!tableName) return undefined;

  const schema: Record<string, YdbPrimitive> = {};
  if (columnsMap) {
    columnsMap.forEach((type, key) => {
      schema[key] = type;
    });
  }

  // Шифруемые поля всегда хранятся как Bytes (raw ciphertext) — формат
  // объявленный в @YdbColumn игнорируется (раньше был base64 в Utf8).
  for (const ef of encryptedFields) {
    schema[ef.propertyKey] = 'Bytes';
  }

  const metadata: YdbEntityMetadata<T> = {
    tableName,
    schema,
    primaryKeys,
    encryptedFields,
    aadFields,
    jsonColumns,
    target,
  };
  metadataCache.set(target, metadata);
  return metadata;
}
