import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';
import {
  YDB_COLUMNS_KEY,
  YDB_PRIMARY_KEYS_KEY,
} from '../metadata/entity-metadata.js';

/**
 * Декоратор свойства. Задаёт YDB-тип колонки.
 * Метаданные клонируются перед изменением (copy-on-write), чтобы
 * наследники не портили метаданные родительского класса.
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
 * Декоратор первичного ключа (опционально, для будущих миграций/индексов).
 * По сути — тот же YdbColumn, но с дополнительной мета-меткой.
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
