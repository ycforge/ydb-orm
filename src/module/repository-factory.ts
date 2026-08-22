import { Provider } from '@nestjs/common';
import {
  YDB_QUERY,
  YDB_OPTIONS,
  YDB_ENCRYPTION_PROVIDER,
  YDB_BLIND_INDEX_PROVIDER,
} from '../core/constants.js';
import type { YdbExecutor, YdbModuleOptions } from '../core/interfaces.js';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getEntityRuntime } from '../entity/entity-runtime.js';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { validateEntityMetadata } from '../metadata/validate-entity.js';
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
    provide: `${entityClass.name}_AR_INIT`,
    useFactory: (
      db: YdbExecutor,
      opts: YdbModuleOptions,
      encryptionProvider?: YdbEncryptionProvider,
      blindIndexProvider?: YdbBlindIndexProvider,
    ) => {
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

      getOrCreateRepository(entityClass as any);

      return entityClass;
    },
    inject: [
      YDB_QUERY,
      YDB_OPTIONS,
      { token: YDB_ENCRYPTION_PROVIDER, optional: true },
      { token: YDB_BLIND_INDEX_PROVIDER, optional: true },
    ],
  };
}
