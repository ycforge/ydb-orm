/**
 * ydb-orm — TypeORM-like ORM для YDB (Yandex Database).
 * Публичный API библиотеки.
 */

// Типы и интерфейсы ядра
export type { YdbPrimitive } from './core/types.js';
export type {
  YdbAuthOptions,
  YdbAuthMethod,
  YdbModuleOptions,
  YdbOptionsFactory,
  YdbModuleAsyncOptions,
  YdbQuery,
  YdbExecutor,
  QueryOptions,
} from './core/interfaces.js';
export {
  YDB_DRIVER,
  YDB_QUERY,
  YDB_OPTIONS,
  YDB_CREDENTIALS_PROVIDER,
  YDB_ENCRYPTION_PROVIDER,
  YDB_BLIND_INDEX_PROVIDER,
  YDB_SCHEMA_SYNC,
} from './core/constants.js';
export { mapToYdb } from './core/mapper.js';
export { quoteIdentifier, validateIdentifier } from './core/sql-utils.js';

// Декораторы
export { YdbEntity } from './decorators/entity.decorator.js';
export { YdbColumn, YdbPrimaryColumn } from './decorators/column.decorator.js';
export {
  YdbEncrypted,
  YdbSecurityAAD,
} from './decorators/encryption.decorator.js';
export type { YdbEncryptedOptions } from './decorators/encryption.decorator.js';
export {
  OneToMany,
  ManyToOne,
  OneToOne,
} from './decorators/relation.decorators.js';
export type {
  RelationMetadata,
  RelationType,
} from './decorators/relation.decorators.js';
export { EagerLoad } from './decorators/eager.decorator.js';

// Active Record
export { YdbBaseEntity } from './entity/base-entity.js';

// Шифрование
export type {
  YdbEncryptionProvider,
  YdbBlindIndexProvider,
  YdbEncryptionContext,
} from './encryption/ydb-encryption-provider.interface.js';
export { Base64TestEncryptionProvider } from './encryption/base64-test-encryption.provider.js';

// Метаданные и реестр сущностей
export { getYdbEntityMetadata } from './metadata/entity-metadata.js';
export type {
  YdbEntityMetadata,
  EncryptedFieldMeta,
} from './metadata/entity-metadata.js';
export {
  registerYdbEntity,
  getRegisteredYdbEntities,
} from './metadata/entity-registry.js';

// Интеграция с NestJS
export { YdbModule } from './module/ydb.module.js';
export { YdbCoreModule } from './module/ydb-core.module.js';

// Schema sync
export {
  YdbSchemaSyncer,
  buildExpectedTableSchema,
  generateCreateTableYql,
  generateAddColumnsYql,
  checkTableSchema,
} from './schema/schema-sync.js';
export type {
  ExpectedTableSchema,
  YdbTableDescription,
  SchemaCheckResult,
  YdbSchemaIssue,
} from './schema/schema-sync.js';

// Транзакции
export { YdbTransactionManager } from './transaction/transaction.manager.js';

// Credentials
export { AuthKeyCredentialsProvider } from './credentials/auth-key-credentials-provider.js';
export type { IamJWTKeyCredentials } from './credentials/auth-key-credentials-provider.js';
