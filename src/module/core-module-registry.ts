import { Driver } from '@ydbjs/core';
import type { YdbModuleOptions } from '../core/interfaces.js';
import {
  beginEntityScope,
  endEntityScope,
} from '../metadata/entity-registry.js';

/**
 * Состояние одного экземпляра YdbCoreModule (создаётся в forRootAsync и
 * живёт в замыкании его провайдеров). Хранит опции и ссылку на драйвер,
 * созданный самим модулем — его модуль закрывает при graceful shutdown.
 */
export interface CoreModuleState {
  options?: YdbModuleOptions;
  /** Драйвер, созданный самим модулем. Если драйвер подменён снаружи
   * (overrideProvider/useValue), поле остаётся undefined и не закрывается. */
  ownedDriver?: Driver;
}

/**
 * Защита от двойного forRootAsync (#93): повторный импорт молча создавал
 * второй Driver/executor/credentials-провайдер, а из-за глобального сайд-эффекта
 * Active Record («последний wins») сущности могли разъехаться по разным executor-ам.
 *
 * Учёт экземпляров lifecycle-aware, а не «навсегда»: экземпляр регистрируется,
 * когда DI резолвит YDB_OPTIONS (момент компиляции модуля — раньше любого хука),
 * и снимается с учёта в onApplicationShutdown. Поэтому последовательные
 * бутстрапы (тесты, hot-restart) разрешены, а два живых одновременно — нет.
 *
 * Это детекция именно in-process дубликатов: гонки DDL между репликами
 * решаются безопасным поведением самого schema sync (DescribeTable перед DDL),
 * здесь они не эмулируются.
 */
const activeCoreModules = new Set<CoreModuleState>();

/**
 * Регистрирует инициализацию ядра. Если в процессе уже живёт другой
 * экземпляр — бросает понятную ошибку вместо тихого создания второго драйвера.
 */
export function claimCoreModuleInit(state: CoreModuleState): void {
  const existing = activeCoreModules.values().next();
  if (!existing.done && existing.value !== state) {
    throw new Error(
      'Duplicate YDB module initialization: ' +
        'YdbCoreModule.forRootAsync() has already created an active connection ' +
        'in this process and it has not been shut down yet. ' +
        'Only one YDB connection per process is supported: import the same ' +
        'YdbModule.forRoot()/YdbCoreModule.forRootAsync() once from the root module ' +
        'so that all entities share one executor, or shut down the previous ' +
        'application (app.close()) before initializing a new one.',
    );
  }
  activeCoreModules.add(state);
  // Скоуп реестра сущностей (#142): всё, что зарегистрировано к этому
  // моменту (и зарегистрируется до shutdown), принадлежит этому приложению.
  beginEntityScope();
}

/** Снимает экземпляр с учёта (идемпотентно) вместе со скоупом его сущностей. */
export function releaseCoreModuleInit(state: CoreModuleState): void {
  activeCoreModules.delete(state);
  endEntityScope();
}
