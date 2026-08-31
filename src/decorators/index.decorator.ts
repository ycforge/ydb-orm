import 'reflect-metadata';

/** Metadata key for secondary indexes (`@YdbIndex`). */
export const YDB_INDEXES_KEY = 'ydb:indexes';

export interface YdbIndexOptions {
  /** Index columns (order matters). */
  columns: string[];
  /** Explicit index name. Default: `{table}__{col1}_{col2}`. */
  name?: string;
  /** Unique index. Default false. */
  unique?: boolean;
}

export interface YdbIndexMetadata {
  columns: string[];
  name?: string;
  unique?: boolean;
}

/**
 * Declarative secondary index (GLOBAL SYNC). A class decorator that can be
 * applied multiple times. Lands in CREATE TABLE during schema sync and in
 * migration:generate.
 *
 * Inheritance semantics (#92): the index is bound to the table of the class
 * on which it is declared and is NOT inherited along the prototype chain. A
 * class with its own @YdbEntity starts with an empty index list and declares
 * its own explicitly — otherwise parent indexes over foreign columns would
 * leak into the child table's CREATE TABLE and break the DDL. Re-applying
 * @YdbIndex on a subclass does not mutate the parent's index list
 * (copy-on-write).
 *
 * @param options - Index options: columns, optional name, unique flag.
 * @returns Class decorator function.
 * @example
 *   @YdbEntity('photos')
 *   @YdbIndex({ columns: ['author_email_bi'] })
 *   @YdbIndex({ columns: ['is_public', 'rating'], name: 'photos__public_rating' })
 *   class PhotoEntity extends YdbBaseEntity { ... }
 */
export function YdbIndex(options: YdbIndexOptions): ClassDecorator {
  return (target) => {
    // Only the class's own metadata: otherwise the parent's indexes would
    // leak in when decorating a subclass (#92).
    const existing: YdbIndexMetadata[] =
      Reflect.getOwnMetadata(YDB_INDEXES_KEY, target) || [];
    // Class decorators apply bottom-up — unshift preserves declaration order.
    const indexes: YdbIndexMetadata[] = [{ ...options }, ...existing];
    Reflect.defineMetadata(YDB_INDEXES_KEY, indexes, target);
  };
}

/**
 * Returns the class's own indexes (not inherited from the parent, #92).
 *
 * @param target - Entity class constructor.
 * @returns Array of index metadata entries.
 */
export function getYdbIndexesMetadata(target: any): YdbIndexMetadata[] {
  return Reflect.getOwnMetadata(YDB_INDEXES_KEY, target) || [];
}

/**
 * Default index name: `{table}__{col1}_{col2}` — grouped by sorting.
 *
 * @param tableName - Table name.
 * @param columns - Index columns.
 * @returns Default index name.
 */
export function resolveIndexName(tableName: string, columns: string[]): string {
  return `${tableName}__${columns.join('_')}`;
}
