import { Provider } from '@nestjs/common';
import {
  YDB_QUERY,
  YDB_OPTIONS,
  YDB_ENCRYPTION_PROVIDER,
  YDB_BLIND_INDEX_PROVIDER,
  YDB_VALIDATION_PROVIDER,
  YDB_CORE_SCOPE,
  YDB_ORM_SCOPE,
  DEFAULT_CONNECTION_NAME,
  getScopedToken,
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
import {
  claimEntitiesForScopeWithTracking,
  releaseEntitiesFromScope,
  type YdbOrmScope,
} from '../core/orm-scope.js';
import { getOrCreateRepository } from '../repository/repository-resolver.js';

/**
 * Провайдер, который при инициализации модуля подключает executor и
 * опциональные encryption/blind-index провайдеры СВОЕЙ конфигурации (#199)
 * к Active Record сущности (см. YdbBaseEntity.setExecutor / setEncryptionProvider).
 * Перед подключением валидирует метаданные сущности (validateEntityMetadata).
 * Также создаёт `YdbRepository` для сущности и сохраняет его в entity-runtime.
 *
 * connectionName выбирает конфигурацию (#199): 'default' — прежние
 * глобальные DI-токены, именованная конфигурация — собственные токены.
 */
export function createActiveRecordEntityProvider(
  entityClass: typeof YdbBaseEntity,
  connectionName: string = DEFAULT_CONNECTION_NAME,
): Provider {
  return {
    provide: getActiveRecordInitToken(entityClass, connectionName),
    useFactory: (
      db: YdbExecutor,
      opts: YdbModuleOptions,
      encryptionProvider?: YdbEncryptionProvider,
      blindIndexProvider?: YdbBlindIndexProvider,
      validationProvider?: YdbValidationProvider,
      entityScope?: YdbEntityAppScope,
      ormScope?: YdbOrmScope,
    ) => {
      // forFeature явно объявляет сущности ЭТОГО приложения (#142): декоратор
      // @YdbEntity уже отработал при первом импорте класса и больше
      // не выполнится (кеш модулей). Скоуп приходит через DI-токен YDB_CORE_SCOPE
      // из контейнера своего приложения, поэтому привязка корректна при любом
      // порядке резолва провайдеров и не затрагивает чужие приложения.
      if (entityScope) {
        requestEntitiesForApp(entityScope, [entityClass]);
      }

      // Валидируем ДО привязки к скоупу: невалидная сущность не получает
      // executor/провайдеры и не оставляет владения (#199 + атомарность).
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

      // Владение сущностью (#199): один класс — одна активная конфигурация.
      // Регистрация в чужой конфигурации — детерминированная ошибка.
      // Запоминаем ново заявленные сущности для отката при ошибке конфигурации.
      let newlyClaimed: (new (...args: any[]) => any)[] = [];
      if (ormScope) {
        newlyClaimed = claimEntitiesForScopeWithTracking(ormScope, [
          entityClass,
        ]);
      }

      try {
        const runtime = getEntityRuntime(entityClass);
        runtime.uuidGenerator = opts.uuidVersion === 'v4' ? uuidv4 : uuidv7;
        // Привязка к конфигурации (#199): per-scope настройки транзакций.
        if (ormScope) {
          runtime.scope = ormScope;
          runtime.transactions = ormScope.transactions;
        }

        entityClass.setExecutor(db);
        // Провайдеры перезаписываются безусловно: повторный бутстрап без них
        // (тесты, hot-restart) не должен оставлять провайдеры прошлой
        // конфигурации — undefined сбрасывает предыдущее значение.
        entityClass.setEncryptionProvider(encryptionProvider);
        entityClass.setBlindIndexProvider(blindIndexProvider);
        entityClass.setValidationProvider(validationProvider);
        entityClass.setAadFormat(opts.aadFormat);
        entityClass.setAadReadFallback(opts.aadReadFallback);

        getOrCreateRepository(entityClass as any);
      } catch (e) {
        if (ormScope && newlyClaimed.length > 0) {
          releaseEntitiesFromScope(ormScope, newlyClaimed);
        }
        throw e;
      }

      return entityClass;
    },
    inject: [
      getScopedToken(YDB_QUERY, connectionName),
      getScopedToken(YDB_OPTIONS, connectionName),
      {
        token: getScopedToken(YDB_ENCRYPTION_PROVIDER, connectionName),
        optional: true,
      },
      {
        token: getScopedToken(YDB_BLIND_INDEX_PROVIDER, connectionName),
        optional: true,
      },
      {
        token: getScopedToken(YDB_VALIDATION_PROVIDER, connectionName),
        optional: true,
      },
      // Скоуп опционален для устойчивости к экзотическим контейнерам без
      // ядра: без него привязка невозможна, но executor всё равно отсутствует
      { token: getScopedToken(YDB_CORE_SCOPE, connectionName), optional: true },
      { token: getScopedToken(YDB_ORM_SCOPE, connectionName), optional: true },
    ],
  };
}
