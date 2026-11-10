import { YdbColumn } from './column.decorator.js';
import { YDB_COLUMNS_KEY } from '../metadata/entity-metadata.js';
import 'reflect-metadata';

export const YDB_CREATE_DATE_KEY = 'ydb:createDateColumn';
export const YDB_UPDATE_DATE_KEY = 'ydb:updateDateColumn';

/**
 * Marks a column as auto-populated with creation timestamp.
 *
 * @returns Property decorator function.
 */
export function YdbCreateDateColumn(): PropertyDecorator {
  return (target, propertyKey) => {
    const columns = Reflect.getMetadata(YDB_COLUMNS_KEY, target.constructor) as
      Map<string, unknown> | undefined;
    if (!columns?.has(String(propertyKey)))
      YdbColumn('Timestamp')(target, propertyKey);
    Reflect.defineMetadata(
      YDB_CREATE_DATE_KEY,
      propertyKey,
      target.constructor,
    );
  };
}

/**
 * Marks a column as auto-populated with last-update timestamp.
 *
 * @returns Property decorator function.
 */
export function YdbUpdateDateColumn(): PropertyDecorator {
  return (target, propertyKey) => {
    const columns = Reflect.getMetadata(YDB_COLUMNS_KEY, target.constructor) as
      Map<string, unknown> | undefined;
    if (!columns?.has(String(propertyKey)))
      YdbColumn('Timestamp')(target, propertyKey);
    Reflect.defineMetadata(
      YDB_UPDATE_DATE_KEY,
      propertyKey,
      target.constructor,
    );
  };
}
