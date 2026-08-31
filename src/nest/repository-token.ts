import { Inject } from '@nestjs/common';
import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbEntityConstructor } from '../persistence/entity-persistence.js';
import { DEFAULT_CONNECTION_NAME } from './constants.js';

const REPOSITORY_TOKEN_PREFIX = 'YDB_REPOSITORY_' as const;
const AR_INIT_TOKEN_SUFFIX = '_AR_INIT' as const;

/**
 * The entity's DI tokens: the repository and the Active Record init
 * provider.
 */
interface EntityDiTokens {
  repository: string;
  arInit: string;
}

/**
 * Registry of class → tokens (issue #94).
 *
 * The token is historically built from the class name but is bound to a
 * specific class: same-named classes from different files/packages get
 * different tokens (the first one in the previous suffix-less format, the
 * rest with a `#N` suffix), so providers no longer silently overwrite each
 * other. A repeated lookup of the same class (forFeature,
 * getRepositoryToken, InjectRepository) always returns the same strings.
 *
 * The WeakMap doesn't hold classes strongly; the name counter only stores
 * strings, so classes are GC'd as before.
 */
const tokensByClass = new WeakMap<
  YdbEntityConstructor<YdbBaseEntity>,
  EntityDiTokens
>();
const claimedNames = new Map<string, number>();

function resolveEntityTokens(
  entityClass: YdbEntityConstructor<YdbBaseEntity>,
): EntityDiTokens {
  const cached = tokensByClass.get(entityClass);
  if (cached) return cached;

  // Anonymous/minified classes may have no name.
  const baseName = entityClass.name || 'AnonymousEntity';

  const ordinal = claimedNames.get(baseName) ?? 0;
  claimedNames.set(baseName, ordinal + 1);

  // The first class with a given name keeps the historic token format;
  // every next same-named class gets a unique suffix — a collision is
  // resolved explicitly rather than by overwriting providers.
  const suffix = ordinal === 0 ? '' : `#${ordinal + 1}`;
  const tokens: EntityDiTokens = {
    repository: `${REPOSITORY_TOKEN_PREFIX}${baseName}${suffix}`,
    arInit: `${baseName}${suffix}${AR_INIT_TOKEN_SUFFIX}`,
  };
  tokensByClass.set(entityClass, tokens);
  return tokens;
}

/**
 * Returns the DI token for the repository of the given entity.
 * connectionName (#199): the configuration the repository belongs to; the
 * default configuration keeps the historic token format.
 */
export function getRepositoryToken<T extends YdbBaseEntity>(
  entityClass: YdbEntityConstructor<T>,
  connectionName: string = DEFAULT_CONNECTION_NAME,
): string {
  const base = resolveEntityTokens(entityClass).repository;
  return connectionName === DEFAULT_CONNECTION_NAME
    ? base
    : `${base}@${connectionName}`;
}

/**
 * Returns the DI token of the provider that wires the executor/providers to
 * the Active Record entity on module initialization (see
 * createActiveRecordEntityProvider). Used both when declaring the provider
 * and in the repository's `inject` — a string mismatch is impossible.
 * connectionName (#199): the configuration the provider belongs to.
 */
export function getActiveRecordInitToken<T extends YdbBaseEntity>(
  entityClass: YdbEntityConstructor<T>,
  connectionName: string = DEFAULT_CONNECTION_NAME,
): string {
  const base = resolveEntityTokens(entityClass).arInit;
  return connectionName === DEFAULT_CONNECTION_NAME
    ? base
    : `${base}@${connectionName}`;
}

/**
 * Decorator to inject an entity's repository into NestJS services.
 *
 * ```ts
 * @Injectable()
 * class UserService {
 *   constructor(@InjectRepository(User) private repo: YdbRepository<User>) {}
 * }
 * ```
 *
 * For a named configuration (#199): `@InjectRepository(User, 'reporting')`.
 */
export function InjectRepository<T extends YdbBaseEntity>(
  entityClass: YdbEntityConstructor<T>,
  connectionName: string = DEFAULT_CONNECTION_NAME,
): ReturnType<typeof Inject> {
  return Inject(getRepositoryToken(entityClass, connectionName));
}
