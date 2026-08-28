import type { YdbExecutor } from '../core/interfaces.js';
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
