import 'reflect-metadata';

export const YDB_EAGER_KEY = 'ydb:eagerLoad';

/**
 * Автоматически подгружает указанные relations при find / findAll.
 *
 * Семантика наследования: связи родителя не затираются — список дочернего
 * класса объединяется с унаследованным (сначала родительские имена, затем
 * новые из потомка). Повторы по имени отбрасываются: первое объявление
 * выигрывает, каждая связь встречается в списке один раз.
 * @example @EagerLoad(['orders', 'profile'])
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

export function getEagerRelations(target: any): string[] {
  return Reflect.getMetadata(YDB_EAGER_KEY, target) || [];
}
