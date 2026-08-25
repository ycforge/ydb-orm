/**
 * ydb-orm — TypeORM-like ORM для YDB (Yandex Database).
 * Публичный API библиотеки.
 */

// Типы и интерфейсы ядра
export type { YdbPrimitive } from './core/types.js';
export type {
  YdbModuleOptions,
  YdbQuery,
  YdbExecutor,
  YdbIsolationLevel,
  YdbTransactionOptions,
  YdbTransactionHandle,
  YdbTransactionsSettings,
  QueryOptions,
  QueryLogger,
  QueryLogEntry,
} from './core/interfaces.js';
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
  BLIND_INDEX_SUFFIX,
  blindIndexColumnName,
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
  resolveRelationJoinColumn,
} from './decorators/relation.decorators.js';
export type {
  RelationMetadata,
  RelationType,
  JoinTableMetadata,
  ManyToManyJoinTable,
  JoinColumnResolutionContext,
} from './decorators/relation.decorators.js';
export { EagerLoad, getEagerRelations } from './decorators/eager.decorator.js';
export { YdbJson, getJsonColumns } from './decorators/json.decorator.js';
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
export {
  isoDurationToSeconds,
  secondsToIsoDuration,
} from './decorators/ttl.decorator.js';
export type {
  YdbTtlOptions,
  YdbTtlMetadata,
  YdbTtlUnit,
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
export {
  DEFAULT_RETRIEVE_LIMIT,
  MAX_RETRIEVE_LIMIT,
} from './query/query-builder.js';
export {
  MAX_IN_CLAUSE_VALUES,
  chunkInValues,
  dedupeInValues,
  resolveRetrieveLimit,
  resolveRetrieveOffset,
} from './core/query-limits.js';
export { executeYdbQuery } from './core/execute-query.js';

// Retry-политика по типу ошибки (#27)
export {
  runWithRetry,
  computeRetryDelayMs,
  classifyYdbError,
  isTransientYdbError,
  validateYdbRetryPolicyOptions,
  resolveYdbRetryPolicy,
  TRANSIENT_YDB_STATUSES,
  DEFAULT_YDB_RETRY_POLICY_OPTIONS,
} from './core/retry.js';
export { withRetryPolicy } from './core/retry-executor.js';
export type {
  YdbRetryPolicyOptions,
  YdbRetryPolicyInput,
  YdbResolvedRetryPolicy,
  YdbRetryAttemptContext,
  YdbErrorKind,
  YdbRetrySleepFn,
  YdbRetryRng,
} from './core/retry.js';

// Репозитории / EntityManager (DI-вариант поверх Active Record)
export {
  YdbRepository,
  YdbEntityManager,
  getOrCreateRepository,
} from './repository/index.js';
export type { YdbEntityConstructor } from './repository/index.js';

// Persistence / Relations (новое ядро ORM)
export { YdbEntityPersistence } from './persistence/index.js';
export { YdbEntityRelations } from './relations/index.js';
export type { PersistenceDeps } from './persistence/index.js';
export type { RelationsDeps } from './relations/index.js';

// Шифрование
export type {
  YdbEncryptionProvider,
  YdbBlindIndexProvider,
  YdbEncryptionContext,
} from './encryption/ydb-encryption-provider.interface.js';
// Тестовая заглушка шифрования вынесена в отдельный пакет
// @ycforge/js-dev-tools (см. README). Готовые KMS/HMAC-провайдеры —
// в @ycforge/orm-security-providers.

// Валидация
export type {
  YdbValidationProvider,
  YdbValidationOptions,
  YdbValidationIssue,
  YdbValidationErrorItem,
} from './validation/ydb-validate.interface.js';
export { ClassValidatorProvider } from './validation/ydb-validate.provider.js';
export {
  YdbEntityValidationError,
  normalizeValidationIssues,
} from './validation/validation-error.js';

// Метаданные и реестр сущностей
export { getYdbEntityMetadata } from './metadata/entity-metadata.js';
export { validateEntityMetadata } from './metadata/validate-entity.js';
export {
  validateYdbTtlAgainstSchema,
  YDB_TTL_KEY,
} from './decorators/ttl.decorator.js';
export type { EntityValidationContext } from './metadata/validate-entity.js';
export type {
  YdbEntityMetadata,
  EncryptedFieldMeta,
} from './metadata/entity-metadata.js';
export {
  registerYdbEntity,
  getRegisteredYdbEntities,
} from './metadata/entity-registry.js';

// Schema sync
export {
  YdbSchemaSyncer,
  buildExpectedTableSchema,
  buildExpectedSchemas,
  generateCreateTableYql,
  generateTtlWithClause,
  generateAddColumnsYql,
  generateAddIndexYql,
  generateDropIndexYql,
  generateSetTtlYql,
  generateResetTtlYql,
  checkTableSchema,
} from './schema/schema-sync.js';
export type {
  ExpectedIndex,
  ExpectedTableSchema,
  YdbTableDescription,
  YdbTableTtl,
  SchemaCheckResult,
  YdbSchemaIssue,
} from './schema/schema-sync.js';

// Транзакции
export { YdbTransactionManager } from './transaction/transaction.manager.js';
export type { RunInTransactionOptions } from './transaction/transaction.manager.js';
export {
  configureTransactionContext,
  getActiveTransaction,
} from './transaction/transaction-context.js';
export type { ActiveTransactionContext } from './transaction/transaction-context.js';

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
  MigrationRecordState,
  YdbMigrationStatus,
} from './migrations/migration-runner.js';
export { loadMigrationsFromDir } from './migrations/migration-loader.js';
export {
  evaluateMigrationCheck,
  migrationStateExitCode,
  MIGRATION_STATE_EXIT_CODES,
} from './migrations/migration-check.js';
export type {
  MigrationCheckState,
  MigrationCheckVerdict,
} from './migrations/migration-check.js';
export { readBookkeepingSnapshot } from './migrations/migration-bookkeeping.js';
export type {
  MigrationBookkeepingSnapshot,
  MigrationBookkeepingDeps,
} from './migrations/migration-bookkeeping.js';
export { computeMigrationStatuses } from './migrations/migration-runner.js';
export {
  planMigration,
  renderMigrationFile,
} from './migrations/migration-generator.js';
export type { PlannedMigration } from './migrations/migration-generator.js';

// Подключение без NestJS (CLI, скрипты)
export {
  resolveCredentialsProvider,
  createDriver,
  createExecutor,
  validateYdbModuleOptions,
} from './core/driver.js';
export { configureEntities } from './core/standalone.js';
export type { YdbCliConfig } from './cli/config.js';
// Генерация сущности без CLI (#24): программный вход для скриптов/инструментов.
export type {
  YdbEntitySpec,
  YdbEntityColumnSpec,
  YdbEntityTtlSpec,
  YdbEnumStorage,
  CreatedFile,
} from './cli/generators.js';
export {
  createEntityFile,
  createEntityFileFromSpec,
  validateEntitySpec,
  renderEntityFile,
  buildDefaultEntitySpec,
  entityFilePath,
  ENTITY_CREATE_TYPES,
  toEnumMemberName,
} from './cli/generators.js';
export {
  runEntityCreateCommand,
  runEntityCreateWizard,
} from './cli/entity-wizard.js';
export type {
  EntityCreateCommandOptions,
  EntityCreateWizardOptions,
} from './cli/entity-wizard.js';
export { PromptCancelledError } from './cli/prompt.js';
// Дамп метаданных (#37): программный вход для внешних инструментов (#36 и др.).
export {
  buildMetadataDump,
  METADATA_DUMP_FORMAT,
  METADATA_DUMP_VERSION,
} from './cli/metadata-dump.js';
export type {
  MetadataDump,
  DumpedEntity,
  DumpedColumn,
  DumpedIndex,
  DumpedTtl,
  DumpedEnum,
  DumpedEncryptedField,
  DumpedRelation,
  DumpedRelationTarget,
  DumpedJoinTable,
  DumpedJoinTableRef,
} from './cli/metadata-dump.js';
// Mermaid ER-диаграмма (#36): рендер поверх канонического дампа метаданных.
export { buildEntityDiagram, writeDiagramFile } from './cli/entity-diagram.js';

// Базовый класс провайдера учётных данных из SDK (#96): тип реэкспортируется,
// чтобы пользователи могли типизировать свои реализации без прямой
// зависимости от @ydbjs/auth.
export type { CredentialsProvider } from '@ydbjs/auth';
