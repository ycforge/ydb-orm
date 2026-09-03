import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';

/** Reflect metadata key for the entity table name. */
export const YDB_ENTITY_KEY = 'ydb:entity';
/** Reflect metadata key for the column map (property → YDB type). */
export const YDB_COLUMNS_KEY = 'ydb:columns';
/** Reflect metadata key for the primary key column list. */
export const YDB_PRIMARY_KEYS_KEY = 'ydb:primaryKeys';
/** Reflect metadata key for encrypted field descriptors. */
export const YDB_ENCRYPTED_KEY = 'ydb:encrypted';
/** Reflect metadata key for Security AAD field names. */
export const YDB_SECURITY_AAD_KEY = 'ydb:security:aad';
/** Reflect metadata key for JSON-serialized column names. */
export const YDB_JSON_COLUMNS_KEY = 'ydb:jsonColumns';

/**
 * Metadata for a single encrypted field (from `@YdbEncrypted`).
 */
export interface EncryptedFieldMeta {
  propertyKey: string;
  blindIndex: boolean;
  aadOverride?: string;
  /** Lazy decryption: field is not decrypted when reading from DB,
   * only on explicit call to decryptField()/decryptLazyFields(). */
  lazy?: boolean;
}

/**
 * Canonical metadata of an `@YdbEntity`-decorated class, built once per
 * class and cached for the lifetime of the process.
 */
export interface YdbEntityMetadata<T = any> {
  tableName: string;
  schema: Record<string, YdbPrimitive>;
  primaryKeys: string[];
  encryptedFields: EncryptedFieldMeta[];
  aadFields: string[];
  /** Columns with automatic JSON serialization (stored as Utf8). */
  jsonColumns: string[];
  target: new (...args: any[]) => T;
}

/**
 * Metadata is collected from Reflect once per class: decorators
 * run at class definition time, before the first query.
 */
const metadataCache = new WeakMap<object, YdbEntityMetadata<any>>();

/**
 * Extracts metadata collected by @YdbEntity / @YdbColumn decorators.
 *
 * Table name is read only from the class's OWN metadata
 * (Reflect.getOwnMetadata, #92): an entity is only the class
 * directly decorated with @YdbEntity. A subclass without its own
 * @YdbEntity is not an entity: it does not inherit the parent's tableName
 * and therefore is not registered as a second class on its table (otherwise
 * buildExpectedSchemas would return duplicates, and sync would patch one
 * table twice). Columns, PK, encryption, AAD, JSON, and enum still inherit
 * through the prototype chain with copy-on-write (see property decorators).
 */
export function getYdbEntityMetadata<T>(
  target: new (...args: any[]) => T,
): YdbEntityMetadata<T> | undefined {
  const cached = metadataCache.get(target);
  if (cached) return cached as YdbEntityMetadata<T>;

  const tableName: string | undefined = Reflect.getOwnMetadata(
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

  // Encrypted fields are always stored as Bytes (raw ciphertext) — format
  // declared in @YdbColumn is ignored (previously was base64 in Utf8).
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
