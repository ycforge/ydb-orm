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
    Reflect.defineMetadata(
      YDB_UPDATE_DATE_KEY,
      propertyKey,
      target.constructor,
    );
  };
}
