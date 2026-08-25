import type { OrmAdapter } from '../adapter.js';
import {
  createDriver,
  createExecutor,
  resolveCredentialsProvider,
  validateYdbModuleOptions,
} from './driver.js';
import { mapToYdb } from './mapper.js';
import {
  classifyYdbError,
  isTransientYdbError,
  resolveYdbRetryPolicy,
} from './retry.js';
import { withRetryPolicy } from './retry-executor.js';
import { YdbSchemaSyncer } from './schema-sync.js';

/**
 * Адаптер YDB — реализация OrmAdapter по умолчанию.
 *
 * Собран из существующих функций (бывшие core/driver, core/retry,
 * core/retry-executor, core/mapper, schema/schema-sync); поведение
 * не изменено — это структурный рефакторинг.
 */
export const ydbAdapter: OrmAdapter = {
  name: 'ydb',

  validateModuleOptions: validateYdbModuleOptions,
  resolveCredentialsProvider,
  createDriver,
  createExecutor,

  mapValue: mapToYdb,

  classifyError: classifyYdbError,
  isTransientError: isTransientYdbError,
  resolveRetryPolicy: resolveYdbRetryPolicy,
  withRetryPolicy,

  createSchemaSyncer: (driver, executor) =>
    new YdbSchemaSyncer(driver, executor),
};

// Публичные символы YDB-адаптера (subpath-экспорт "@ycforge/yorm/ydb").
export {
  createDriver,
  createExecutor,
  resolveCredentialsProvider,
  validateYdbModuleOptions,
} from './driver.js';
export { mapToYdb } from './mapper.js';
export {
  runWithRetry,
  computeRetryDelayMs,
  classifyYdbError,
  isTransientYdbError,
  validateYdbRetryPolicyOptions,
  resolveYdbRetryPolicy,
  TRANSIENT_YDB_STATUSES,
  DEFAULT_YDB_RETRY_POLICY_OPTIONS,
  RETRY_DEFAULT_MAX_ATTEMPTS,
  RETRY_DEFAULT_BASE_DELAY_MS,
  RETRY_DEFAULT_MAX_DELAY_MS,
  RETRY_DEFAULT_JITTER_RATIO,
} from './retry.js';
export type {
  YdbRetryPolicyOptions,
  YdbRetryPolicyInput,
  YdbResolvedRetryPolicy,
  YdbRetryAttemptContext,
  YdbErrorKind,
  YdbRetrySleepFn,
  YdbRetryRng,
} from './retry.js';
export { withRetryPolicy } from './retry-executor.js';
export {
  YdbSchemaSyncer,
  buildExpectedTableSchema,
  buildExpectedJoinTableSchema,
  buildExpectedSchemas,
  generateCreateTableYql,
  generateTtlWithClause,
  generateAddColumnsYql,
  generateAddIndexYql,
  generateDropIndexYql,
  generateSetTtlYql,
  generateResetTtlYql,
  checkTableSchema,
  describePrimaryKeyMismatch,
  checkToIssues,
  diffSchemas,
} from './schema-sync.js';
export type {
  ExpectedIndex,
  ExpectedTableSchema,
  YdbTableDescription,
  YdbTableTtl,
  LikelyRename,
  SchemaCheckResult,
  YdbSchemaIssue,
} from './schema-sync.js';
