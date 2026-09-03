import 'reflect-metadata';

/** Metadata key for enum columns (`@YdbEnum`). */
export const YDB_ENUM_KEY = 'ydb:enum';

export interface YdbEnumMeta {
  propertyKey: string;
  values: readonly string[];
  /** 'Utf8' stores string values, 'Int32' — the ordinal number. Default: 'Utf8'. */
  storage: 'Utf8' | 'Int32';
}

/**
 * Enum column decorator: maps an enum ↔ Utf8 (string value) or Int32
 * (ordinal number).
 *
 * Inheritance and re-application semantics: the last declaration wins
 * (last-write-wins). Overriding @YdbEnum on a property inherited from a
 * parent replaces values/storage — it is not ignored. Each propertyKey has
 * exactly one entry in the metadata.
 *
 * @param options - Enum options: values array and optional storage type.
 * @returns Property decorator function.
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

/**
 * Returns the enum metadata for an entity class.
 *
 * @param target - Entity class constructor.
 * @returns Array of enum metadata entries.
 */
export function getYdbEnumMetadata(
  target: new (...args: any[]) => any,
): YdbEnumMeta[] {
  return Reflect.getMetadata(YDB_ENUM_KEY, target) || [];
}
