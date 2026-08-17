import { Provider } from '@nestjs/common';
import {
  YDB_QUERY,
  YDB_ENCRYPTION_PROVIDER,
  YDB_BLIND_INDEX_PROVIDER,
} from '../core/constants.js';
import type { YdbExecutor } from '../core/interfaces.js';
import {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import { YdbBaseEntity } from '../entity/base-entity.js';

/**
 * Провайдер, который при инициализации модуля подключает глобальный
 * executor и опциональные encryption/blind-index провайдеры к Active Record
 * сущности (см. YdbBaseEntity.setExecutor / setEncryptionProvider).
 */
export function createActiveRecordEntityProvider(
  entityClass: typeof YdbBaseEntity,
): Provider {
  return {
    provide: `${entityClass.name}_AR_INIT`,
    useFactory: (
      db: YdbExecutor,
      encryptionProvider?: YdbEncryptionProvider,
      blindIndexProvider?: YdbBlindIndexProvider,
    ) => {
      entityClass.setExecutor(db);
      if (encryptionProvider) {
        entityClass.setEncryptionProvider(encryptionProvider);
      }
      if (blindIndexProvider) {
        entityClass.setBlindIndexProvider(blindIndexProvider);
      }
      return entityClass;
    },
    inject: [
      YDB_QUERY,
      { token: YDB_ENCRYPTION_PROVIDER, optional: true },
      { token: YDB_BLIND_INDEX_PROVIDER, optional: true },
    ],
  };
}
