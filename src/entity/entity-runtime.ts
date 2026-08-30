import type { YdbExecutor } from '../core/interfaces.js';
import type { YdbTransactionsSettings } from '../core/interfaces.js';
import type { YdbOrmScope } from '../core/orm-scope.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { AadFormat } from '../encryption/aad.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import type { YdbBaseEntity } from './base-entity.js';
import type { YdbRepository } from '../repository/ydb-repository.js';

/**
 * Снапшот зависимостей, использованных при создании repository.
 * Хранится в runtime для пересоздания repository при смене deps.
 */
export interface RepositoryDepsSnapshot {
  executor?: YdbExecutor;
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  validationProvider?: YdbValidationProvider;
  uuidGenerator?: () => string;
  aadFormat?: AadFormat;
  aadReadFallback?: boolean;
}

export interface EntityRuntime {
  executor?: YdbExecutor;
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  validationProvider?: YdbValidationProvider;
  /** Генератор UUID для PK (по умолчанию v7 — см. base-entity). */
  uuidGenerator?: () => string;
  /** Формат Security AAD (#165); undefined = 'v2' по умолчанию. */
  aadFormat?: AadFormat;
  /**
   * Автоматическое определение формата AAD при чтении (#165);
   * undefined = true (безопасный переход legacy → v2).
   */
  aadReadFallback?: boolean;
  /** Готовый репозиторий сущности (создаётся лениво из deps). */
  repository?: YdbRepository<YdbBaseEntity>;
  /** Снапшот deps, использованных для создания repository. */
  repositoryDeps?: RepositoryDepsSnapshot;
  /**
   * Скоуп ORM-конфигурации, которой принадлежит сущность (#199);
   * undefined — сущность ещё не сконфигурирована.
   */
  scope?: YdbOrmScope;
  /**
   * Настройки транзакций конфигурации-владельца (#199); undefined —
   * используются процессно-глобальные настройки (прежнее поведение).
   */
  transactions?: Required<YdbTransactionsSettings>;
}

/**
 * Рантайм-зависимости Active Record сущностей.
 * Хранятся отдельно от классов (а не в статических полях с any-кастами),
 * ключ — конкретный класс сущности, поэтому наследники не разделяют состояние.
 */
const runtimes = new WeakMap<typeof YdbBaseEntity, EntityRuntime>();

export function getEntityRuntime(target: typeof YdbBaseEntity): EntityRuntime {
  let runtime = runtimes.get(target);
  if (!runtime) {
    runtime = {};
    runtimes.set(target, runtime);
  }
  return runtime;
}

/**
 * Снимок runtime-состояния сущности ДО применения конфигурации для
 * атомарного отката (#200). Используется configureEntities() и
 * createActiveRecordEntityProvider(): если конфигурация падает после того,
 * как часть runtime уже изменена, restoreEntityRuntime() возвращает сущность
 * ровно в то состояние, в котором она была до вызова.
 *
 * Контракт (обязателен для корректности поверхностного снимка):
 * конфигурация заменяет только ВЕРХНЕУРОВНЕВЫЕ поля runtime (executor,
 * провайдеры, uuidGenerator, aadFormat, aadReadFallback, scope, transactions,
 * repository, repositoryDeps), присваивая новые значения по ссылке. Ни одно
 * вложенное значение (scope.transactions, repositoryDeps, repository) внутри
 * не мутируется в месте — поэтому копирования ссылок достаточно для точного
 * восстановления прежних ссылок. Если появится поле, которое мутируется
 * в месте (например, `runtime.transactions.ambient = true`), его снимок
 * нужно делать здесь глубоким, а restoreEntityRuntime() — дополнить.
 */
export function snapshotEntityRuntime(
  entityClass: typeof YdbBaseEntity,
): EntityRuntime {
  return { ...getEntityRuntime(entityClass) };
}

/**
 * Восстанавливает runtime-состояние сущности из снимка (см.
 * snapshotEntityRuntime). Помимо присваивания сохранённых ссылок удаляет
 * поля, которых не было в снимке: если конфигурация добавила новое поле
 * (не существовавшее до вызова), оно не должно пережить откат.
 */
export function restoreEntityRuntime(
  entityClass: typeof YdbBaseEntity,
  snapshot: EntityRuntime,
): void {
  const runtime = getEntityRuntime(entityClass);
  const snapshotKeys = new Set(Object.keys(snapshot));
  for (const key of Object.keys(runtime)) {
    if (!snapshotKeys.has(key)) {
      delete (runtime as Record<string, unknown>)[key];
    }
  }
  Object.assign(runtime, snapshot);
}
