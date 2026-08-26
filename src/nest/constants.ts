export const YDB_DRIVER = Symbol('YDB_DRIVER');
export const YDB_QUERY = Symbol('YDB_QUERY');
export const YDB_OPTIONS = Symbol('YDB_OPTIONS');
export const YDB_CREDENTIALS_PROVIDER = Symbol('YDB_CREDENTIALS_PROVIDER');
export const YDB_ENCRYPTION_PROVIDER = Symbol('YDB_ENCRYPTION_PROVIDER');
export const YDB_BLIND_INDEX_PROVIDER = Symbol('YDB_BLIND_INDEX_PROVIDER');
export const YDB_VALIDATION_PROVIDER = Symbol('YDB_VALIDATION_PROVIDER');
export const YDB_SCHEMA_SYNC = Symbol('YDB_SCHEMA_SYNC');
/** Скоуп сущностей конкретного экземпляра ядра (#142): значение уникально
 * для каждого вызова YdbCoreModule.forRootAsync(), поэтому провайдеры
 * forFeature привязывают сущности к СВОЕМУ приложению независимо от
 * порядка резолва провайдеров. */
export const YDB_CORE_SCOPE = Symbol('YDB_CORE_SCOPE');
/**
 * Внутренний lifecycle-провайдер YdbCoreModule (schema sync на bootstrap,
 * закрытие драйвера и снятие с учёта при shutdown). Наружу не экспортируется.
 */
export const YDB_CORE_LIFECYCLE = Symbol('YDB_CORE_LIFECYCLE');
