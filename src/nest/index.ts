/**
 * @ycforge/ydb-orm/nest — NestJS integration for the package.
 *
 * The subpackage exists so the main @ycforge/ydb-orm package remains
 * framework-neutral (works without NestJS). It contains:
 * - NestJS modules: YdbOrmModule / YdbCoreModule (+ internal providers);
 * - DI tokens and repository helpers: YDB_*, getRepositoryToken,
 *   getActiveRecordInitToken, InjectRepository;
 * - async option types (YdbModuleAsyncOptions / YdbOptionsFactory).
 *
 * For convenience, the entire public API of the main package is also
 * re-exported — a single import is sufficient for NestJS applications.
 */
export * from '../index.js';
export { YdbOrmModule } from './ydb-orm.module.js';
export { YdbCoreModule } from './ydb-core.module.js';
export { createActiveRecordEntityProvider } from './repository-factory.js';
export {
  getRepositoryToken,
  getActiveRecordInitToken,
  InjectRepository,
} from './repository-token.js';
export {
  YDB_DRIVER,
  YDB_QUERY,
  YDB_OPTIONS,
  YDB_CREDENTIALS_PROVIDER,
  YDB_ENCRYPTION_PROVIDER,
  YDB_BLIND_INDEX_PROVIDER,
  YDB_VALIDATION_PROVIDER,
  YDB_SCHEMA_SYNC,
  YDB_CORE_SCOPE,
  YDB_CORE_LIFECYCLE,
  YDB_ORM_SCOPE,
  YDB_CONNECTION_NAME,
  DEFAULT_CONNECTION_NAME,
  getScopedToken,
  getTransactionManagerToken,
} from './constants.js';
export type { YdbOptionsFactory, YdbModuleAsyncOptions } from './interfaces.js';
