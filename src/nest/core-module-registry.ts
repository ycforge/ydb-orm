import { Driver } from '@ydbjs/core';
import type { YdbModuleOptions } from '../core/interfaces.js';
import type { YdbEntityAppScope } from '../metadata/entity-registry.js';
import type { YdbOrmScope } from '../core/orm-scope.js';

/**
 * State of a single YdbCoreModule instance (created in forRootAsync and
 * living in the closure of its providers). Holds the options, the driver
 * created by the module itself — which the module closes on graceful
 * shutdown — and the entity scope of this application (#142).
 */
export interface CoreModuleState {
  options?: YdbModuleOptions;
  /** Driver created by the module itself. If the driver is replaced from
   * outside (overrideProvider/useValue), the field stays undefined and is
   * not closed. */
  ownedDriver?: Driver;
  /** Entities of THIS application: forFeature providers bind them through
   * the YDB_CORE_SCOPE DI token, so foreign applications never get here. */
  readonly entityScope: YdbEntityAppScope;
  /** Configuration name (#199): 'default' or a custom one. */
  readonly name: string;
  /** ORM configuration scope (#199): entity ownership and per-scope
   * transaction settings. Released on application shutdown. */
  readonly ormScope: YdbOrmScope;
}

/**
 * Protection against a double forRootAsync (#93) and tracking of
 * independent configurations (#199): a repeated import with THE SAME name
 * would silently create a second Driver/executor/credentials provider, and
 * because of the per-class Active Record runtime ("last wins") entities
 * could end up spread across different executors. Configurations with
 * DIFFERENT names are allowed and isolated.
 *
 * Instance tracking is lifecycle-aware, not "forever": an instance is
 * registered when DI resolves YDB_OPTIONS (module compilation time —
 * before any hook) and unregistered in onApplicationShutdown. Sequential
 * bootstraps (tests, hot-restart) are therefore allowed, but two live
 * instances under the same name at once are not.
 *
 * This detects only in-process duplicates: DDL races between replicas are
 * resolved by the safe behavior of schema sync itself (DescribeTable
 * before DDL); they are not emulated here.
 */
const activeCoreModules = new Set<CoreModuleState>();

/**
 * Registers a core initialization. If another instance with the same
 * configuration name is already live in this process, throws a clear error
 * instead of silently creating a second driver.
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

/** Unregisters an instance (idempotent). The entity scope lives in the
 * instance's state and is GC'd together with it — there is nothing to
 * clean globally (#142). */
export function releaseCoreModuleInit(state: CoreModuleState): void {
  activeCoreModules.delete(state);
}
