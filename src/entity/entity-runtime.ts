import type { YdbExecutor } from '../core/interfaces.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { YdbBaseEntity } from './base-entity.js';

export interface EntityRuntime {
  executor?: YdbExecutor;
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
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
