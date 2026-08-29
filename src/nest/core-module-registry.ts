import { Driver } from '@ydbjs/core';
import type { YdbModuleOptions } from '../core/interfaces.js';
import type { YdbEntityAppScope } from '../metadata/entity-registry.js';
import type { YdbOrmScope } from '../core/orm-scope.js';

/**
 * Состояние одного экземпляра YdbCoreModule (создаётся в forRootAsync и
 * живёт в замыкании его провайдеров). Хранит опции, ссылку на драйвер,
 * созданный самим модулем — его модуль закрывает при graceful shutdown —
 * и скоуп сущностей этого приложения (#142).
 */
export interface CoreModuleState {
  options?: YdbModuleOptions;
  /** Драйвер, созданный самим модулем. Если драйвер подменён снаружи
   * (overrideProvider/useValue), поле остаётся undefined и не закрывается. */
  ownedDriver?: Driver;
  /** Сущности ЭТОГО приложения: их привязывают провайдеры forFeature через
   * DI-токен YDB_CORE_SCOPE, поэтому чужие приложения сюда не попадают. */
  readonly entityScope: YdbEntityAppScope;
  /** Имя конфигурации (#199): 'default' или пользовательское. */
  readonly name: string;
  /** Скоуп ORM-конфигурации (#199): владение сущностями и per-scope
   * настройки транзакций. Освобождается при shutdown приложения. */
  readonly ormScope: YdbOrmScope;
}

/**
 * Защита от двойного forRootAsync (#93) и учёт независимых конфигураций
 * (#199): повторный импорт с ТЕМ ЖЕ именем молча создавал бы второй
 * Driver/executor/credentials-провайдер, а из-за per-class runtime
 * Active Record («последний wins») сущности могли разъехаться по разным
 * executor-ам. Конфигурации с РАЗНЫМИ именами допустимы и изолированы.
 *
 * Учёт экземпляров lifecycle-aware, а не «навсегда»: экземпляр регистрируется,
 * когда DI резолвит YDB_OPTIONS (момент компиляции модуля — раньше любого хука),
 * и снимается с учёта в onApplicationShutdown. Поэтому последовательные
 * бутстрапы (тесты, hot-restart) разрешены, а два живых одновременно
 * с одним именем — нет.
 *
 * Это детекция именно in-process дубликатов: гонки DDL между репликами
 * решаются безопасным поведением самого schema sync (DescribeTable перед DDL),
 * здесь они не эмулируются.
 */
const activeCoreModules = new Set<CoreModuleState>();

/**
 * Регистрирует инициализацию ядра. Если в процессе уже живёт другой
 * экземпляр с тем же именем конфигурации — бросает понятную ошибку
 * вместо тихого создания второго драйвера.
 */
export function claimCoreModuleInit(state: CoreModuleState): void {
  for (const existing of activeCoreModules) {
    if (existing !== state && existing.name === state.name) {
      throw new Error(
        'Duplicate YDB module initialization: ' +
          `YdbCoreModule.forRootAsync() has already created an active connection ` +
          `"${state.name}" in this process and it has not been shut down yet. ` +
          'Only one YDB connection per name per process is supported: import the same ' +
          'YdbOrmModule.forRoot()/YdbCoreModule.forRootAsync() once from the root module ' +
          'so that all entities share one executor, give the second configuration a ' +
          'distinct "name" (#199), or shut down the previous ' +
          'application (app.close()) before initializing a new one.',
      );
    }
  }
  activeCoreModules.add(state);
}

/** Снимает экземпляр с учёта (идемпотентно). Скоуп сущностей живёт в
 * состоянии экземпляра и уходит в GC вместе с ним — глобально чистить
 * нечего (#142). */
export function releaseCoreModuleInit(state: CoreModuleState): void {
  activeCoreModules.delete(state);
}
