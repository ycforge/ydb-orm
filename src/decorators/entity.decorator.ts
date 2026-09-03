import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';
import { validateTableName } from '../core/sql-utils.js';
import {
  YDB_ENTITY_KEY,
  YDB_COLUMNS_KEY,
} from '../metadata/entity-metadata.js';
import { registerYdbEntity } from '../metadata/entity-registry.js';

/**
 * Class decorator. Sets the table name in YDB.
 * The class is also registered in the global entity registry (see
 * entity-registry).
 *
 * The table name is validated immediately at decoration time (#91): it is
 * used to build the path for DescribeTable and DDL, so an invalid name must
 * fail at module load rather than on the first DB access.
 *
 * @param tableName - Table name in YDB (must match /^[a-zA-Z_][a-zA-Z0-9_]*$/).
 * @returns Class decorator function.
 * @throws If tableName is invalid.
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
