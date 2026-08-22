import 'reflect-metadata';

export const YDB_ENUM_KEY = 'ydb:enum';

export interface YdbEnumMeta {
  propertyKey: string;
  values: readonly string[];
  /** 'Utf8' хранит строковые значения, 'Int32' — порядковый номер. По умолчанию: 'Utf8'. */
  storage: 'Utf8' | 'Int32';
}

/**
 * Декоратор enum-колонки: маппинг enum ↔ Utf8 (строковое значение) или Int32 (порядковый номер).
 *
 * Семантика наследования и повторного применения: последняя декларация
 * побеждает (last-write-wins). Переопределение @YdbEnum на свойстве,
 * унаследованном от родителя, заменяет values/storage — а не игнорируется.
 * Для каждого propertyKey в метаданных остаётся ровно одна запись.
 * @example
 *   enum Status { ACTIVE = 'active', INACTIVE = 'inactive' }
 *
 *   @YdbColumn('Utf8')
 *   @YdbEnum({ values: Object.values(Status), storage: 'Utf8' })
 *   status: Status;
 */
export function YdbEnum(options: {
  values: readonly string[];
  storage?: 'Utf8' | 'Int32';
}): PropertyDecorator {
  return (target, propertyKey) => {
    const constructor = target.constructor;
    const existing: YdbEnumMeta[] =
      Reflect.getMetadata(YDB_ENUM_KEY, constructor) || [];

    const list: YdbEnumMeta[] = [
      ...existing.filter((e) => e.propertyKey !== propertyKey),
      {
        propertyKey: propertyKey as string,
        values: options.values,
        storage: options.storage ?? 'Utf8',
      },
    ];
    Reflect.defineMetadata(YDB_ENUM_KEY, list, constructor);
  };
}

export function getYdbEnumMetadata(
  target: new (...args: any[]) => any,
): YdbEnumMeta[] {
  return Reflect.getMetadata(YDB_ENUM_KEY, target) || [];
}
