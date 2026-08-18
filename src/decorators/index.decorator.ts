import 'reflect-metadata';

export const YDB_INDEXES_KEY = 'ydb:indexes';

export interface YdbIndexOptions {
  /** Колонки индекса (порядок важен). */
  columns: string[];
  /** Явное имя индекса. По умолчанию: `{table}__{col1}_{col2}`. */
  name?: string;
  /** Уникальный индекс. По умолчанию false. */
  unique?: boolean;
}

export interface YdbIndexMetadata {
  columns: string[];
  name?: string;
  unique?: boolean;
}

/**
 * Декларативный вторичный индекс (GLOBAL SYNC). Класс-декоратор,
 * можно вешать несколько раз. Попадает в CREATE TABLE при schema sync
 * и в migration:generate.
 *
 * @example
 *   @YdbEntity('photos')
 *   @YdbIndex({ columns: ['author_email_bi'] })
 *   @YdbIndex({ columns: ['is_public', 'rating'], name: 'photos__public_rating' })
 *   class PhotoEntity extends YdbBaseEntity { ... }
 */
export function YdbIndex(options: YdbIndexOptions): ClassDecorator {
  return (target) => {
    const existing: YdbIndexMetadata[] =
      Reflect.getMetadata(YDB_INDEXES_KEY, target) || [];
    // Класс-декораторы применяются снизу вверх — unshift сохраняет порядок объявления.
    const indexes: YdbIndexMetadata[] = [{ ...options }, ...existing];
    Reflect.defineMetadata(YDB_INDEXES_KEY, indexes, target);
  };
}

export function getYdbIndexesMetadata(target: any): YdbIndexMetadata[] {
  return Reflect.getMetadata(YDB_INDEXES_KEY, target) || [];
}

/** Имя индекса по умолчанию: `{table}__{col1}_{col2}` — группируется сортировкой. */
export function resolveIndexName(tableName: string, columns: string[]): string {
  return `${tableName}__${columns.join('_')}`;
}
