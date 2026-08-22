import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';
import { validateTableName } from '../core/sql-utils.js';
import {
  YDB_ENTITY_KEY,
  YDB_COLUMNS_KEY,
} from '../metadata/entity-metadata.js';
import { registerYdbEntity } from '../metadata/entity-registry.js';

/**
 * Декоратор класса. Задаёт имя таблицы в YDB.
 * Класс также попадает в глобальный реестр сущностей (см. entity-registry).
 *
 * Имя таблицы валидируется сразу при декорировании (#91): из него
 * собирается путь для DescribeTable и DDL, поэтому невалидное имя
 * должно падать при загрузке модуля, а не на первом обращении к БД.
 */
export function YdbEntity(tableName: string): ClassDecorator {
  return (target) => {
    validateTableName(tableName);

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
