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
  QueryLogger,
  QueryLogEntry,
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
export {
  ConsoleQueryLogger,
  wrapExecutorWithLogging,
} from './core/query-logger.js';

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
  ManyToMany,
  JoinTable,
  getYdbRelationsMetadata,
  getYdbJoinTableMetadata,
  getManyToManyJoinTables,
} from './decorators/relation.decorators.js';
export type {
  RelationMetadata,
  RelationType,
  JoinTableMetadata,
  ManyToManyJoinTable,
} from './decorators/relation.decorators.js';
export { EagerLoad } from './decorators/eager.decorator.js';
export {
  YdbCreateDateColumn,
  YdbUpdateDateColumn,
} from './decorators/timestamp.decorator.js';
export {
  YdbIndex,
  getYdbIndexesMetadata,
  resolveIndexName,
} from './decorators/index.decorator.js';
export type {
  YdbIndexMetadata,
  YdbIndexOptions,
} from './decorators/index.decorator.js';
export { YdbEnum, getYdbEnumMetadata } from './decorators/enum.decorator.js';
export type { YdbEnumMeta } from './decorators/enum.decorator.js';
export { YdbTtl, getYdbTtlMetadata } from './decorators/ttl.decorator.js';
export type {
  YdbTtlOptions,
  YdbTtlMetadata,
} from './decorators/ttl.decorator.js';
export {
  BeforeInsert,
  AfterInsert,
  BeforeUpdate,
  AfterFind,
  BeforeRemove,
  getLifecycleHooks,
} from './decorators/lifecycle.decorator.js';
export type { LifecycleHooks } from './decorators/lifecycle.decorator.js';

// Active Record
export { YdbBaseEntity } from './entity/base-entity.js';
export { YdbQueryBuilder } from './query/query-builder.js';
export type { BuiltQuery, OrderDirection } from './query/query-builder.js';

// Шифрование
export type {
  YdbEncryptionProvider,
  YdbBlindIndexProvider,
  YdbEncryptionContext,
} from './encryption/ydb-encryption-provider.interface.js';
export { Base64TestEncryptionProvider } from './encryption/base64-test-encryption.provider.js';
export {
  KmsEncryptionProvider,
  KmsBlindIndexProvider,
} from './encryption/kms-encryption.provider.js';
export type { KmsEncryptionProviderOptions } from './encryption/kms-encryption.provider.js';

// Валидация
export type {
  YdbValidationProvider,
  YdbValidationOptions,
} from './validation/ydb-validate.interface.js';
export { ClassValidatorProvider } from './validation/ydb-validate.provider.js';

// Метаданные и реестр сущностей
export { getYdbEntityMetadata } from './metadata/entity-metadata.js';
export { validateEntityMetadata } from './metadata/validate-entity.js';
export type { EntityValidationContext } from './metadata/validate-entity.js';
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

// Миграции
export type {
  YdbMigration,
  YdbMigrationClass,
} from './migrations/migration.interface.js';
export { executeSql } from './migrations/migration.interface.js';
export {
  YdbMigrationRunner,
  MIGRATIONS_TABLE,
} from './migrations/migration-runner.js';
export type {
  AppliedMigration,
  YdbMigrationStatus,
} from './migrations/migration-runner.js';
export { loadMigrationsFromDir } from './migrations/migration-loader.js';
export {
  planMigration,
  renderMigrationFile,
} from './migrations/migration-generator.js';
export type { PlannedMigration } from './migrations/migration-generator.js';

// Подключение без NestJS (CLI, скрипты)
export {
  createCredentialsProvider,
  createDriver,
  createExecutor,
} from './core/driver.js';
export { configureEntities } from './core/standalone.js';
export type { YdbCliConfig } from './cli/config.js';

// Credentials
export { AuthKeyCredentialsProvider } from './credentials/auth-key-credentials-provider.js';
export type { IamJWTKeyCredentials } from './credentials/auth-key-credentials-provider.js';
