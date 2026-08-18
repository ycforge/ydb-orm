import 'reflect-metadata';

export const YDB_TTL_KEY = 'ydb:ttl';

export interface YdbTtlOptions {
  /** ISO 8601 duration (например, "PT2H", "P30D", "PT1H"). */
  interval: string;
  /** Колонка для TTL. По умолчанию — первый PK. */
  column?: string;
}

export interface YdbTtlMetadata {
  interval: string;
  column: string;
}

/**
 * Декларативный TTL таблицы (YDB table TTL).
 * Можно применить только один раз на класс.
 * Генерирует TTL = Interval(...) ON `column` в CREATE TABLE DDL.
 *
 * @example
 *   @YdbEntity('sessions')
 *   @YdbTtl({ interval: 'PT2H' })
 *   class SessionEntity extends YdbBaseEntity { ... }
 */
export function YdbTtl(options: YdbTtlOptions): ClassDecorator {
  return (target) => {
    const existing = Reflect.getMetadata(YDB_TTL_KEY, target);
    if (existing) {
      throw new Error(
        `@YdbTtl can only be applied once to class "${target.name}"`,
      );
    }
    Reflect.defineMetadata(YDB_TTL_KEY, options, target);
  };
}

export function getYdbTtlMetadata(
  target: new (...args: any[]) => any,
): YdbTtlOptions | undefined {
  return Reflect.getMetadata(YDB_TTL_KEY, target);
}
