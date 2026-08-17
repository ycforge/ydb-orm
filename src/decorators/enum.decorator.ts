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

    if (existing.some((e) => e.propertyKey === propertyKey)) return;

    Reflect.defineMetadata(
      YDB_ENUM_KEY,
      [
        ...existing,
        {
          propertyKey: propertyKey as string,
          values: options.values,
          storage: options.storage ?? 'Utf8',
        },
      ],
      constructor,
    );
  };
}

export function getYdbEnumMetadata(
  target: new (...args: any[]) => any,
): YdbEnumMeta[] {
  return Reflect.getMetadata(YDB_ENUM_KEY, target) || [];
}
