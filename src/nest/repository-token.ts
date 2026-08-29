import { Inject } from '@nestjs/common';
import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbEntityConstructor } from '../persistence/entity-persistence.js';
import { DEFAULT_CONNECTION_NAME } from './constants.js';

const REPOSITORY_TOKEN_PREFIX = 'YDB_REPOSITORY_' as const;
const AR_INIT_TOKEN_SUFFIX = '_AR_INIT' as const;

/**
 * DI-токены сущности: репозиторий и провайдер инициализации Active Record.
 */
interface EntityDiTokens {
  repository: string;
  arInit: string;
}

/**
 * Реестр class → токены (issue #94).
 *
 * Токен исторически строится из имени класса, но привязывается к конкретному
 * классу: одноимённые классы из разных файлов/пакетов получают разные токены
 * (первый — в прежнем формате без суффикса, последующие — с суффиксом `#N`),
 * поэтому провайдеры больше не перезаписывают друг друга молча. Повторное
 * обращение к тому же классу (forFeature, getRepositoryToken,
 * InjectRepository) всегда возвращает те же строки.
 *
 * WeakMap не держит класс сильной ссылкой; счётчик занятых имён хранит
 * только строки, поэтому классы собираются GC как раньше.
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

  // У анонимных/сминифицированных классов имя может отсутствовать.
  const baseName = entityClass.name || 'AnonymousEntity';

  const ordinal = claimedNames.get(baseName) ?? 0;
  claimedNames.set(baseName, ordinal + 1);

  // Первый класс с данным именем сохраняет исторический формат токена;
  // каждый следующий одноимённый класс получает уникальный суффикс —
  // коллизия разрешается явно, а не перезаписью провайдеров.
  const suffix = ordinal === 0 ? '' : `#${ordinal + 1}`;
  const tokens: EntityDiTokens = {
    repository: `${REPOSITORY_TOKEN_PREFIX}${baseName}${suffix}`,
    arInit: `${baseName}${suffix}${AR_INIT_TOKEN_SUFFIX}`,
  };
  tokensByClass.set(entityClass, tokens);
  return tokens;
}

/**
 * Возвращает DI-токен для репозитория указанной сущности.
 * connectionName (#199): конфигурация, которой принадлежит репозиторий;
 * дефолтная конфигурация сохраняет исторический формат токена.
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
 * Возвращает DI-токен провайдера, который при инициализации модуля
 * подключает executor/провайдеры к Active Record сущности
 * (см. createActiveRecordEntityProvider). Используется и при объявлении
 * провайдера, и в `inject` репозитория — рассинхрон строк невозможен.
 * connectionName (#199): конфигурация, которой принадлежит провайдер.
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
 * Декоратор для инъекции репозитория сущности в NestJS-сервисы.
 *
 * ```ts
 * @Injectable()
 * class UserService {
 *   constructor(@InjectRepository(User) private repo: YdbRepository<User>) {}
 * }
 * ```
 *
 * Для именованной конфигурации (#199): `@InjectRepository(User, 'reporting')`.
 */
export function InjectRepository<T extends YdbBaseEntity>(
  entityClass: YdbEntityConstructor<T>,
  connectionName: string = DEFAULT_CONNECTION_NAME,
): ReturnType<typeof Inject> {
  return Inject(getRepositoryToken(entityClass, connectionName));
}
