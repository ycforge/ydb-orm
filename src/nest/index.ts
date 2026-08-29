/**
 * @ycforge/ydb-orm/nest — NestJS-интеграция пакета.
 *
 * Подпакет существует, чтобы основной пакет @ycforge/ydb-orm оставался
 * каркасно-нейтральным (работает без NestJS). Здесь собраны:
 * - модули NestJS: YdbOrmModule / YdbCoreModule (+ внутренние провайдеры);
 * - DI-токены и помощники репозиториев: YDB_*, getRepositoryToken,
 *   getActiveRecordInitToken, InjectRepository;
 * - типы async-опций (YdbModuleAsyncOptions / YdbOptionsFactory).
 *
 * Для удобства NestJS-приложений реэкспортируется и весь публичный API
 * основного пакета — достаточно одного импорта.
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
