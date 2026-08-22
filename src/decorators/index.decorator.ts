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
 * Семантика наследования (#92): индекс привязан к таблице того класса,
 * на котором объявлен, и НЕ наследуется по цепочке прототипов. Класс
 * с собственным @YdbEntity начинает с пустого списка индексов и объявляет
 * свои явно — иначе родительские индексы по чужим колонкам попали бы
 * в CREATE TABLE дочерней таблицы и уронили DDL. Повтор @YdbIndex на
 * наследнике не мутирует список индексов родителя (copy-on-write).
 *
 * @example
 *   @YdbEntity('photos')
 *   @YdbIndex({ columns: ['author_email_bi'] })
 *   @YdbIndex({ columns: ['is_public', 'rating'], name: 'photos__public_rating' })
 *   class PhotoEntity extends YdbBaseEntity { ... }
 */
export function YdbIndex(options: YdbIndexOptions): ClassDecorator {
  return (target) => {
    // Только собственные метаданные класса: иначе при декорировании
    // наследника сюда затесались бы индексы родителя (#92).
    const existing: YdbIndexMetadata[] =
      Reflect.getOwnMetadata(YDB_INDEXES_KEY, target) || [];
    // Класс-декораторы применяются снизу вверх — unshift сохраняет порядок объявления.
    const indexes: YdbIndexMetadata[] = [{ ...options }, ...existing];
    Reflect.defineMetadata(YDB_INDEXES_KEY, indexes, target);
  };
}

/** Собственные индексы класса (не наследуются от родителя, #92). */
export function getYdbIndexesMetadata(target: any): YdbIndexMetadata[] {
  return Reflect.getOwnMetadata(YDB_INDEXES_KEY, target) || [];
}

/** Имя индекса по умолчанию: `{table}__{col1}_{col2}` — группируется сортировкой. */
export function resolveIndexName(tableName: string, columns: string[]): string {
  return `${tableName}__${columns.join('_')}`;
}
