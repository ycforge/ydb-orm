import type { YdbExecutor } from './interfaces.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { YdbBaseEntity } from '../entity/base-entity.js';

/**
 * Конфигурация сущностей для программного использования без NestJS.
 * Устанавливает executor и (опционально) провайдеры шифрования
 * на каждую переданную сущность.
 *
 * @example
 * ```ts
 * import { configureEntities, createDriver, createExecutor } from '@ycforge/ydb-orm';
 *
 * const driver = await createDriver({ endpoint: '...', auth_type: 'meta' });
 * const executor = createExecutor(driver, { endpoint: '...', auth_type: 'meta' });
 * configureEntities([UserEntity, PostEntity], { executor });
 * ```
 */
export function configureEntities(
  entities: (new (...args: any[]) => any)[],
  options: {
    executor: YdbExecutor;
    encryptionProvider?: YdbEncryptionProvider;
    blindIndexProvider?: YdbBlindIndexProvider;
  },
): void {
  for (const entity of entities) {
    (entity as unknown as typeof YdbBaseEntity).setExecutor(options.executor);

    if (options.encryptionProvider) {
      (entity as unknown as typeof YdbBaseEntity).setEncryptionProvider(
        options.encryptionProvider,
      );
    }

    if (options.blindIndexProvider) {
      (entity as unknown as typeof YdbBaseEntity).setBlindIndexProvider(
        options.blindIndexProvider,
      );
    }
  }
}
