import 'reflect-metadata';
import { YDB_JSON_COLUMNS_KEY } from '../metadata/entity-metadata.js';

/**
 * Декоратор свойства: колонка хранится как JSON-строка (Utf8 в БД),
 * но автоматически сериализуется/десериализуется при записи/чтении.
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
 *   // В БД: '{"role":"admin","settings":{"theme":"dark"}}'
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

/** Возвращает список JSON-колонок для класса сущности. */
export function getJsonColumns(target: any): string[] {
  return Reflect.getMetadata(YDB_JSON_COLUMNS_KEY, target) || [];
}
