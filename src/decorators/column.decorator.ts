import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';
import {
  YDB_COLUMNS_KEY,
  YDB_PRIMARY_KEYS_KEY,
} from '../metadata/entity-metadata.js';

/**
 * Property decorator. Sets the YDB type of the column.
 *
 * Metadata is cloned before being modified (copy-on-write), so that
 * subclasses do not corrupt the parent class's metadata.
 *
 * @param type - YDB primitive type for the column.
 * @returns Property decorator function.
 */
export function YdbColumn(type: YdbPrimitive): PropertyDecorator {
  return (target, propertyKey) => {
    const constructor = target.constructor;
    const inherited: Map<string, YdbPrimitive> | undefined =
      Reflect.getMetadata(YDB_COLUMNS_KEY, constructor);
    const columns = new Map<string, YdbPrimitive>(inherited);

    columns.set(propertyKey as string, type);
    Reflect.defineMetadata(YDB_COLUMNS_KEY, columns, constructor);
  };
}

/**
 * Primary key decorator (optional, for future migrations/indexes).
 * Essentially the same as YdbColumn but with an additional meta-label.
 *
 * @param type - YDB primitive type for the primary key column.
 * @returns Property decorator function.
 */
export function YdbPrimaryColumn(type: YdbPrimitive): PropertyDecorator {
  return (target, propertyKey) => {
    YdbColumn(type)(target, propertyKey);

    const constructor = target.constructor;
    const inherited: string[] =
      Reflect.getMetadata(YDB_PRIMARY_KEYS_KEY, constructor) || [];
    if (inherited.includes(propertyKey as string)) return;
    Reflect.defineMetadata(
      YDB_PRIMARY_KEYS_KEY,
      [...inherited, propertyKey as string],
      constructor,
    );
  };
}
