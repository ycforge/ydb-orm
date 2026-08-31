import 'reflect-metadata';
import { YDB_JSON_COLUMNS_KEY } from '../metadata/entity-metadata.js';

/**
 * Property decorator: the column is stored as a JSON string (Utf8 in the DB)
 * but automatically serialized/deserialized on write/read.
 *
 * @example
 *   @YdbEntity('users')
 *   class UserEntity extends YdbBaseEntity {
 *     @YdbJson()
 *     metadata: { role: string; settings: Record<string, any> };
 *   }
 *
 *   const user = new UserEntity();
 *   user.metadata = { role: 'admin', settings: { theme: 'dark' } };
 *   await UserEntity.save(user);
 *   // In DB: '{"role":"admin","settings":{"theme":"dark"}}'
 *
 * @returns Property decorator function.
 */
export function YdbJson(): PropertyDecorator {
  return (target, propertyKey) => {
    const constructor = target.constructor;
    const existing: string[] =
      Reflect.getMetadata(YDB_JSON_COLUMNS_KEY, constructor) || [];
    if (existing.includes(propertyKey as string)) return;
    Reflect.defineMetadata(
      YDB_JSON_COLUMNS_KEY,
      [...existing, propertyKey as string],
      constructor,
    );
  };
}

/**
 * Returns the list of JSON columns for an entity class.
 *
 * @param target - Entity class constructor.
 * @returns Array of JSON column property names.
 */
export function getJsonColumns(target: any): string[] {
  return Reflect.getMetadata(YDB_JSON_COLUMNS_KEY, target) || [];
}
