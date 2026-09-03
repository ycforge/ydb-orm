/**
 * Entity registry: @YdbEntity decorator registers the class at module
 * load time. Needed for schema sync (`sync` option in forRoot) to find
 * all entities without an explicit entities list in module options.
 *
 * Important: a class enters the registry only if its file was imported
 * (typically via YdbOrmModule.forFeature / NestJS module imports).
 *
 * Entity ownership (#142): each YdbCoreModule instance (i.e., each
 * NestJS application) has its own scope — createEntityScope() is called
 * on the static side of forRootAsync, and forFeature providers bind
 * entities to THEIR application's scope via the YDB_CORE_SCOPE DI token.
 * Provider resolution order doesn't matter: an entity physically cannot
 * end up in a foreign application. An application that fails with
 * Duplicate YDB module initialization takes its bindings with it.
 *
 * Outside an active application (CLI, standalone, unit tests),
 * getRegisteredYdbEntities() without an argument returns the entire
 * global registry — previous behavior; re-registration is idempotent (Set).
 */
type EntityCtor = new (...args: any[]) => any;

/** All decorated classes for the lifetime of the process (never cleared). */
const registry = new Set<EntityCtor>();

/** Scope of entities for one application: a plain Set, owned by its core. */
export type YdbEntityAppScope = Set<EntityCtor>;

/** Creates an empty scope for a new core instance (called from forRootAsync). */
export function createEntityScope(): YdbEntityAppScope {
  return new Set<EntityCtor>();
}

/** Registers an `@YdbEntity`-decorated class in the process-global registry. */
export function registerYdbEntity(target: EntityCtor): void {
  // The decorator runs at module load time and knows about no application —
  // registration is process-global only. Binding to a specific application
  // is done by YdbOrmModule.forFeature (#142).
  registry.add(target);
}

/**
 * Explicitly binds entities to a specific application's scope (#142).
 *
 * Called from the AR provider factory (YdbOrmModule.forFeature): the
 * @YdbEntity decorator runs once per process lifetime (ESM module cache),
 * so a re-application in the same process won't "re-register" its entities
 * on its own — without explicit binding, schema sync would see an empty
 * set. The scope comes via the YDB_CORE_SCOPE DI token and is guaranteed
 * to belong to the container of the application where the provider was
 * created, so the binding is correct both BEFORE the core claim (entity
 * just waits in the future application's scope) and after it.
 */
export function requestEntitiesForApp(
  scope: YdbEntityAppScope,
  entities: readonly EntityCtor[],
): void {
  for (const entity of entities) {
    registry.add(entity);
    scope.add(entity);
  }
}

/**
 * Entities for schema sync/verify. With argument — the set of a specific
 * application; without argument (CLI, standalone) — the entire global
 * registry.
 */
export function getRegisteredYdbEntities(
  scope?: YdbEntityAppScope,
): EntityCtor[] {
  if (scope) {
    return [...scope];
  }
  return [...registry];
}
