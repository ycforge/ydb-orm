import 'reflect-metadata';

export const YDB_EAGER_KEY = 'ydb:eagerLoad';

/**
 * Автоматически подгружает указанные relations при find / findAll.
 * @example @EagerLoad(['orders', 'profile'])
 */
export function EagerLoad(relations: string[]): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(YDB_EAGER_KEY, relations, target);
  };
}

export function getEagerRelations(target: any): string[] {
  return Reflect.getMetadata(YDB_EAGER_KEY, target) || [];
}
