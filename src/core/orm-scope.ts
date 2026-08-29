import type { YdbTransactionsSettings } from './interfaces.js';

/**
 * Скоуп одной независимой ORM-конфигурации (#199).
 *
 * Раньше конфигурация была процессно-глобальной: один executor, одни
 * настройки транзакций, один набор сущностей на процесс. Скоуп делает
 * конфигурацию instance-scoped: у каждого скоупа собственные настройки
 * транзакций и собственный набор сущностей, а executor/провайдеры
 * изолируются естественно — через per-class entity runtime (сущность
 * физически не может быть подключена к двум конфигурациям сразу).
 *
 * Контракт владения: один класс сущности принадлежит ровно одному
 * АКТИВНОМУ скоупу. Повторная регистрация в другом скоупе —
 * детерминированная ошибка (см. claimEntitiesForScope). Освобождение —
 * releaseOrmScope() (NestJS вызывает при shutdown приложения).
 */
export interface YdbOrmScope {
  /** Имя конфигурации: 'default' или пользовательское (NestJS `name`). */
  readonly name: string;
  /**
   * Настройки транзакций этой конфигурации (#98/#199). undefined —
   * наследуются процессно-глобальные настройки (configureTransactionContext),
   * что сохраняет прежнее поведение standalone/тестов.
   */
  transactions?: Required<YdbTransactionsSettings>;
  /** Сущности, привязанные к этой конфигурации. */
  readonly entities: Set<YdbEntityClass>;
}

type YdbEntityClass = new (...args: any[]) => any;

/** Имя конфигурации по умолчанию (обратная совместимость). */
export const DEFAULT_ORM_SCOPE_NAME = 'default';

/**
 * Владение сущностями: класс → активный скоуп-владелец.
 * Обычный Map (не WeakMap): владение снимается явно через releaseOrmScope,
 * а GC классов сущностей на практике не происходит.
 */
const entityOwners = new Map<YdbEntityClass, YdbOrmScope>();

function normalizeTransactions(
  settings?: YdbTransactionsSettings,
): Required<YdbTransactionsSettings> {
  return {
    ambient: settings?.ambient ?? false,
    warnOutsideTransaction: settings?.warnOutsideTransaction ?? false,
  };
}

/**
 * Создаёт скоуп новой независимой конфигурации (#199).
 *
 * Standalone-пример:
 * ```ts
 * const reporting = createOrmScope('reporting', { transactions: { ambient: true } });
 * configureEntities([ReportEntity], { executor: reportingExecutor, scope: reporting });
 * ```
 */
export function createOrmScope(
  name: string = DEFAULT_ORM_SCOPE_NAME,
  options?: { transactions?: YdbTransactionsSettings },
): YdbOrmScope {
  if (!name) {
    throw new Error('createOrmScope(): scope name must be a non-empty string.');
  }
  return {
    name,
    transactions: options?.transactions
      ? normalizeTransactions(options.transactions)
      : undefined,
    entities: new Set(),
  };
}

let defaultScope: YdbOrmScope | undefined;

/**
 * Скоуп конфигурации по умолчанию — ленивый синглтон. Именно он
 * используется configureEntities() без options.scope и дефолтной
 * конфигурацией NestJS, поэтому одиночная конфигурация и повторный
 * бутстрап (тесты, hot-restart) работают как раньше: скоуп никогда
 * не освобождается, повторный claim своих же сущностей идемпотентен.
 */
export function getDefaultOrmScope(): YdbOrmScope {
  if (!defaultScope) {
    defaultScope = createOrmScope(DEFAULT_ORM_SCOPE_NAME);
  }
  return defaultScope;
}

/**
 * Привязывает сущности к скоупу конфигурации (#199).
 *
 * Сущность, уже принадлежащая ДРУГОМУ активному скоупу, — понятная
 * ошибка конфигурации (тот же класс не может жить в двух конфигурациях:
 * его per-class runtime один). Повторный claim тем же скоупом
 * идемпотентен — это re-bootstrap в рамках одной конфигурации.
 */
export function claimEntitiesForScope(
  scope: YdbOrmScope,
  entities: readonly YdbEntityClass[],
): void {
  for (const entity of entities) {
    const owner = entityOwners.get(entity);
    if (owner && owner !== scope) {
      throw new Error(
        `Entity ${entity.name ?? String(entity)} is already registered in ` +
          `another YDB configuration ("${owner.name}"). ` +
          `The same entity class cannot belong to more than one ORM configuration: ` +
          `its executor/providers are stored per class. ` +
          `Declare a separate entity class for configuration "${scope.name}", ` +
          `or shut down the configuration "${owner.name}" first.`,
      );
    }
  }
  for (const entity of entities) {
    entityOwners.set(entity, scope);
    scope.entities.add(entity);
  }
}

/**
 * Снимает владение скоупа над его сущностями (shutdown приложения).
 * Идемпотентно. После release сущности можно привязать к другому скоупу.
 */
export function releaseOrmScope(scope: YdbOrmScope): void {
  for (const entity of scope.entities) {
    if (entityOwners.get(entity) === scope) {
      entityOwners.delete(entity);
    }
  }
  scope.entities.clear();
}

/** Текущий владелец сущности (для тестов и диагностики). */
export function getEntityOrmScope(
  entity: YdbEntityClass,
): YdbOrmScope | undefined {
  return entityOwners.get(entity);
}
