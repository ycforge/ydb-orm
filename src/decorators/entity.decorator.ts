import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';
import {
  YDB_ENTITY_KEY,
  YDB_COLUMNS_KEY,
} from '../metadata/entity-metadata.js';
import { registerYdbEntity } from '../metadata/entity-registry.js';

/**
 * Декоратор класса. Задаёт имя таблицы в YDB.
 * Класс также попадает в глобальный реестр сущностей (см. entity-registry).
 */
export function YdbEntity(tableName: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(YDB_ENTITY_KEY, tableName, target);
    registerYdbEntity(target as unknown as new (...args: any[]) => any);

    if (!Reflect.hasMetadata(YDB_COLUMNS_KEY, target)) {
      Reflect.defineMetadata(
        YDB_COLUMNS_KEY,
        new Map<string, YdbPrimitive>(),
        target,
      );
    }
  };
}
