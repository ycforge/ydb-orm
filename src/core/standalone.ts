import type { YdbExecutor } from './interfaces.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getEntityRuntime } from '../entity/entity-runtime.js';
import { getOrCreateRepository } from '../repository/repository-resolver.js';
import { validateEntityMetadata } from '../metadata/validate-entity.js';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

/**
 * Конфигурация сущностей для программного использования без NestJS.
 * Валидирует метаданные каждой сущности, устанавливает executor,
 * генератор UUID (uuidVersion), провайдеры шифрования и валидации
 * на каждую переданную сущность и создаёт для неё YdbRepository.
 *
 * Повторный вызов полностью заменяет конфигурацию: если провайдеры
 * не переданы, прошлые сбрасываются (актуально для тестов и hot-restart).
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
    validationProvider?: YdbValidationProvider;
    /** Версия генерируемых UUID для PK: v7 (по умолчанию) или v4. */
    uuidVersion?: 'v4' | 'v7';
  },
): void {
  if (!options?.executor) {
    throw new Error(
      'configureEntities() requires "options.executor". ' +
        'Create it via createExecutor(driver, opts).',
    );
  }

  // Сначала валидируем все сущности: невалидная сущность не должна
  // получить executor/провайдеры и падать позже с малопонятной ошибкой.
  for (const entity of entities) {
    assertEntityClass(entity);
    const issues = validateEntityMetadata(
      entity as unknown as typeof YdbBaseEntity,
      {
        encryptionProviderConfigured: Boolean(options.encryptionProvider),
        blindIndexProviderConfigured: Boolean(options.blindIndexProvider),
      },
    );
    if (issues.length) {
      throw new Error(
        `configureEntities(): metadata validation failed for ${entity.name}:\n` +
          issues.map((i) => `  - ${i}`).join('\n'),
      );
    }
  }

  // Затем применяем конфигурацию. Провайдеры перезаписываются безусловно:
  // undefined сбрасывает провайдеры прошлой конфигурации при re-bootstrap.
  for (const entity of entities) {
    const entityClass = entity as unknown as typeof YdbBaseEntity;
    getEntityRuntime(entityClass).uuidGenerator =
      options.uuidVersion === 'v4' ? uuidv4 : uuidv7;

    entityClass.setExecutor(options.executor);
    entityClass.setEncryptionProvider(options.encryptionProvider);
    entityClass.setBlindIndexProvider(options.blindIndexProvider);
    entityClass.setValidationProvider(options.validationProvider);

    getOrCreateRepository(entityClass);
  }
}

function assertEntityClass(entity: unknown): void {
  if (
    typeof entity !== 'function' ||
    !(entity.prototype instanceof YdbBaseEntity)
  ) {
    throw new Error(
      `configureEntities(): ${(entity as any)?.name ?? String(entity)} ` +
        `is not a YdbBaseEntity subclass. ` +
        `Only entities extending YdbBaseEntity can be configured.`,
    );
  }
}
