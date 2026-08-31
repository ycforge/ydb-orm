import { YdbTransactionManager } from '../transaction/transaction.manager.js';

/** DI token of the YDB driver. */
export const YDB_DRIVER = Symbol('YDB_DRIVER');
/** DI token of the YDB executor (query interface). */
export const YDB_QUERY = Symbol('YDB_QUERY');
/** DI token of the resolved YdbModuleOptions. */
export const YDB_OPTIONS = Symbol('YDB_OPTIONS');
/** DI token of the resolved credentials provider (#96). */
export const YDB_CREDENTIALS_PROVIDER = Symbol('YDB_CREDENTIALS_PROVIDER');
/** DI token of the optional encryption provider. */
export const YDB_ENCRYPTION_PROVIDER = Symbol('YDB_ENCRYPTION_PROVIDER');
/** DI token of the optional blind index provider. */
export const YDB_BLIND_INDEX_PROVIDER = Symbol('YDB_BLIND_INDEX_PROVIDER');
/** DI token of the optional validation provider. */
export const YDB_VALIDATION_PROVIDER = Symbol('YDB_VALIDATION_PROVIDER');
/** DI token of the DB schema synchronizer. */
export const YDB_SCHEMA_SYNC = Symbol('YDB_SCHEMA_SYNC');
/** Entity scope of a specific core instance (#142): the value is unique per
 * YdbCoreModule.forRootAsync() call, so forFeature providers bind entities
 * to THEIR application regardless of provider resolution order. */
export const YDB_CORE_SCOPE = Symbol('YDB_CORE_SCOPE');
/** ORM configuration scope (#199): entity ownership and per-scope
 * transaction settings. The value is unique per forRootAsync call. */
export const YDB_ORM_SCOPE = Symbol('YDB_ORM_SCOPE');
/** Configuration name (#199): the useValue string in core providers also
 * makes the dynamic module's module token unique per name (otherwise
 * NestJS deduplicates two forRootAsync calls of the same class). */
export const YDB_CONNECTION_NAME = Symbol('YDB_CONNECTION_NAME');
/**
 * Internal YdbCoreModule lifecycle provider (schema sync on bootstrap,
 * closing the driver and unregistering on shutdown). Not exported publicly.
 */
export const YDB_CORE_LIFECYCLE = Symbol('YDB_CORE_LIFECYCLE');

/** Default configuration name (#199). */
export const DEFAULT_CONNECTION_NAME = 'default';

/**
 * DI token of a specific configuration (#199). For the default
 * configuration the original symbol is returned (single-configuration
 * backward compatibility); named configurations get their own tokens, so
 * several YdbCoreModule instances with different names don't collide in
 * DI. Tokens are memoized: a repeated call with the same base+name returns
 * THE SAME symbol (Symbol(description) is not equal to another such
 * symbol).
 */
const scopedTokens = new Map<string, symbol>();

export function getScopedToken(base: symbol, name: string): symbol {
  if (name === DEFAULT_CONNECTION_NAME) return base;
  const key = `${base.description ?? 'YDB'}#${name}`;
  let token = scopedTokens.get(key);
  if (!token) {
    token = Symbol(key);
    scopedTokens.set(key, token);
  }
  return token;
}

/** YdbTransactionManager token of a specific configuration (#199): for
 * the default one — the historic class token, for named ones — its own
 * symbol. */
export function getTransactionManagerToken(
  name: string,
): symbol | typeof YdbTransactionManager {
  if (name === DEFAULT_CONNECTION_NAME) return YdbTransactionManager;
  return getScopedToken(YDB_TRANSACTION_MANAGER_BASE, name);
}

const YDB_TRANSACTION_MANAGER_BASE = Symbol('YDB_TRANSACTION_MANAGER');
