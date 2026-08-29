import type { YdbExecutor } from './interfaces.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import type { AadFormat } from '../encryption/aad.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getEntityRuntime } from '../entity/entity-runtime.js';
import { getOrCreateRepository } from '../repository/repository-resolver.js';
import { validateEntityMetadata } from '../metadata/validate-entity.js';
import {
  claimEntitiesForScopeWithTracking,
  getDefaultOrmScope,
  releaseEntitiesFromScope,
  type YdbOrmScope,
} from './orm-scope.js';
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
 * const driver = await createDriver({ endpoint: '...', auth: createAuth({ type: 'metadata' }) });
 * const executor = createExecutor(driver, { endpoint: '...', auth: createAuth({ type: 'metadata' }) });
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
    /**
     * Формат сериализации Security AAD (#165): 'v2' (по умолчанию) или
     * 'legacy' — только для переходного периода (дешифровка старого ciphertext).
     */
    aadFormat?: AadFormat;
    /**
     * Автоматическое определение формата AAD при чтении (#165): true (по
     * умолчанию) — при сбое основного формата пробуется второй, legacy-строки
     * читаемы после апгрейда на v2; false — строгий режим после перешифровки.
     */
    aadReadFallback?: boolean;
    /**
     * Скоуп независимой ORM-конфигурации (#199), создаётся через
     * createOrmScope(). По умолчанию — процессный скоуп 'default'
     * (прежнее поведение одиночной конфигурации). Один класс сущности
     * может принадлежать только одному активному скоупу: регистрация
     * в чужом скоупе — ошибка.
     */
    scope?: YdbOrmScope;
  },
): void {
  if (!options?.executor) {
    throw new Error(
      'configureEntities() requires "options.executor". ' +
        'Create it via createExecutor(driver, opts).',
    );
  }

  const scope = options.scope ?? getDefaultOrmScope();

  // 1. Валидируем все сущности ДО привязки к скоупу: невалидная
  // сущность не получает executor/провайдеры и не оставляет владения.
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

  // 2. Привязываем сущности к скоупу (идемпотентно) и запоминаем,
  // какие из них были ново заявлены — для отката при ошибке конфигурации.
  const newlyClaimed = claimEntitiesForScopeWithTracking(scope, entities);

  // 3. Применяем runtime-конфигурацию. Снимаем снимок состояния
  // каждого класса сущности перед применением, чтобы при ошибке
  // в середине цикла откатить все мутации (executor, providers, uuidGenerator,
  // aadFormat, scope, transactions, repository) и оставить сущности
  // в точно таком же состоянии, как до вызова configureEntities.
  const runtimeSnapshots = new Map<
    typeof YdbBaseEntity,
    ReturnType<typeof getEntityRuntime>
  >();
  for (const entity of entities) {
    const entityClass = entity as unknown as typeof YdbBaseEntity;
    runtimeSnapshots.set(entityClass, { ...getEntityRuntime(entityClass) });
  }

  try {
    for (const entity of entities) {
      const entityClass = entity as unknown as typeof YdbBaseEntity;
      const runtime = getEntityRuntime(entityClass);
      runtime.uuidGenerator = options.uuidVersion === 'v4' ? uuidv4 : uuidv7;
      runtime.scope = scope;
      runtime.transactions = scope.transactions;

      entityClass.setExecutor(options.executor);
      entityClass.setEncryptionProvider(options.encryptionProvider);
      entityClass.setBlindIndexProvider(options.blindIndexProvider);
      entityClass.setValidationProvider(options.validationProvider);
      entityClass.setAadFormat(options.aadFormat);
      entityClass.setAadReadFallback(options.aadReadFallback);

      getOrCreateRepository(entityClass);
    }
  } catch (e) {
    for (const entity of entities) {
      const entityClass = entity as unknown as typeof YdbBaseEntity;
      const snapshot = runtimeSnapshots.get(entityClass);
      if (snapshot) {
        Object.assign(getEntityRuntime(entityClass), snapshot);
      }
    }
    releaseEntitiesFromScope(scope, newlyClaimed);
    throw e;
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
