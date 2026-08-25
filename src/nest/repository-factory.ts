import { Provider } from '@nestjs/common';
import {
  YDB_QUERY,
  YDB_OPTIONS,
  YDB_ENCRYPTION_PROVIDER,
  YDB_BLIND_INDEX_PROVIDER,
  YDB_VALIDATION_PROVIDER,
  YDB_CORE_SCOPE,
} from './constants.js';
import type { YdbExecutor, YdbModuleOptions } from '../core/interfaces.js';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getEntityRuntime } from '../entity/entity-runtime.js';
import { getActiveRecordInitToken } from './repository-token.js';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { validateEntityMetadata } from '../metadata/validate-entity.js';
import {
  requestEntitiesForApp,
  type YdbEntityAppScope,
} from '../metadata/entity-registry.js';
import { getOrCreateRepository } from '../repository/repository-resolver.js';

/**
 * Провайдер, который при инициализации модуля подключает глобальный
 * executor и опциональные encryption/blind-index провайдеры к Active Record
 * сущности (см. YdbBaseEntity.setExecutor / setEncryptionProvider).
 * Перед подключением валидирует метаданные сущности (validateEntityMetadata).
 * Также создаёт `YdbRepository` для сущности и сохраняет его в entity-runtime.
 */
export function createActiveRecordEntityProvider(
  entityClass: typeof YdbBaseEntity,
): Provider {
  return {
    provide: getActiveRecordInitToken(entityClass),
    useFactory: (
      db: YdbExecutor,
      opts: YdbModuleOptions,
      encryptionProvider?: YdbEncryptionProvider,
      blindIndexProvider?: YdbBlindIndexProvider,
      validationProvider?: YdbValidationProvider,
      entityScope?: YdbEntityAppScope,
    ) => {
      // forFeature явно объявляет сущности ЭТОГО приложения (#142): декоратор
      // @YdbEntity уже отработал при первом импорте класса и больше не
      // выполнится (кеш модулей). Скоуп приходит через DI-токен YDB_CORE_SCOPE
      // из контейнера своего приложения, поэтому привязка корректна при любом
      // порядке резолва провайдеров и не затрагивает чужие приложения.
      if (entityScope) {
        requestEntitiesForApp(entityScope, [entityClass]);
      }

      const issues = validateEntityMetadata(entityClass, {
        encryptionProviderConfigured: Boolean(encryptionProvider),
        blindIndexProviderConfigured: Boolean(blindIndexProvider),
      });
      if (issues.length) {
        throw new Error(
          `Entity ${entityClass.name} metadata validation failed:\n` +
            issues.map((i) => `  - ${i}`).join('\n'),
        );
      }

      getEntityRuntime(entityClass).uuidGenerator =
        opts.uuidVersion === 'v4' ? uuidv4 : uuidv7;

      entityClass.setExecutor(db);
      // Провайдеры перезаписываются безусловно: повторный бутстрап без них
      // (тесты, hot-restart) не должен оставлять провайдеры прошлой
      // конфигурации — undefined сбрасывает предыдущее значение.
      entityClass.setEncryptionProvider(encryptionProvider);
      entityClass.setBlindIndexProvider(blindIndexProvider);
      entityClass.setValidationProvider(validationProvider);

      getOrCreateRepository(entityClass as any);

      return entityClass;
    },
    inject: [
      YDB_QUERY,
      YDB_OPTIONS,
      { token: YDB_ENCRYPTION_PROVIDER, optional: true },
      { token: YDB_BLIND_INDEX_PROVIDER, optional: true },
      { token: YDB_VALIDATION_PROVIDER, optional: true },
      // Скоуп опционален для устойчивости к экзотическим контейнерам без
      // ядра: без него привязка невозможна, но executor всё равно отсутствует
      { token: YDB_CORE_SCOPE, optional: true },
    ],
  };
}
