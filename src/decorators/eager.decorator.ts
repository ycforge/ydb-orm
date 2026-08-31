import 'reflect-metadata';

export const YDB_EAGER_KEY = 'ydb:eagerLoad';

/**
 * Eagerly loads the specified relations on find / findAll.
 *
 * Inheritance semantics: the parent's relations are not overwritten — the
 * child class's list merges with the inherited one (parent names first,
 * then new ones from the child). Duplicate names are dropped: the first
 * declaration wins, and each relation appears in the list once.
 *
 * @param relations - Array of relation property names to eager load.
 * @example @EagerLoad(['orders', 'profile'])
 * @returns Class decorator function.
 */
export function EagerLoad(relations: string[]): ClassDecorator {
  return (target) => {
    const inherited: string[] =
      Reflect.getMetadata(YDB_EAGER_KEY, target) || [];
    const merged: string[] = [...inherited];
    for (const name of relations) {
      if (!merged.includes(name)) merged.push(name);
    }
    Reflect.defineMetadata(YDB_EAGER_KEY, merged, target);
  };
}

/**
 * Returns the eager load relations for an entity class.
 *
 * @param target - Entity class constructor.
 * @returns Array of relation property names to eager load.
 */
export function getEagerRelations(target: any): string[] {
  return Reflect.getMetadata(YDB_EAGER_KEY, target) || [];
}
