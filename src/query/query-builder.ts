import type { YdbBaseEntity } from '../entity/base-entity.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import type { QueryOptions } from '../core/query-options.js';
import type { YdbPrimitive } from '../core/types.js';
import {
  resolveRetrieveLimit,
  resolveRetrieveOffset,
} from '../core/query-limits.js';

// Константы живут в core/query-limits.ts (единая точка семантики LIMIT/OFFSET
// для билдера и persistence); реэкспорт сохраняет публичный API.
export {
  DEFAULT_RETRIEVE_LIMIT,
  MAX_RETRIEVE_LIMIT,
} from '../core/query-limits.js';

export type OrderDirection = 'ASC' | 'DESC';

/** Результат toYql(): собранный SQL и значения параметров (до маппинга в типы YDB). */
export interface BuiltQuery {
  sql: string;
  values: Record<string, any>;
}

interface CompiledQuery extends BuiltQuery {
  keys: string[];
  dbSchema: Record<string, YdbPrimitive>;
}

type EntityClass<T extends YdbBaseEntity> = {
  new (): T;
} & typeof YdbBaseEntity;

/**
 * Цепочный query builder поверх Active Record сущности.
 * Условия where/andWhere — только равенство, объединяются через AND
 * (повторное поле в andWhere перезаписывает предыдущее).
 * Зашифрованные поля с blind index поддерживаются так же, как в find/findAll.
 *
 * Билдер переиспользуем: методы-строители (where/orderBy/limit/... ) и методы
 * выполнения (getMany/getOne/toYql) не мутируют состояние друг друга.
 * Один и тот же билдер можно выполнить несколько раз — результат одинаковый.
 *
 * @example
 *   const photos = await PhotoEntity.query()
 *     .where({ is_public: true })
 *     .orderBy('rating', 'DESC')
 *     .limit(20)
 *     .getMany();
 */
export class YdbQueryBuilder<T extends YdbBaseEntity> {
  private whereValues: Record<string, any> = {};
  private orderClauses: { field: string; direction: OrderDirection }[] = [];
  private limitValue?: number;
  private offsetValue?: number;
  private queryOptions?: QueryOptions;
  private selectColumns?: string[];

  constructor(private readonly entity: EntityClass<T>) {}

  /** Добавить условия равенства (AND). Повторный вызов дополняет условия. */
  where(criteria: Record<string, any>): this {
    this.whereValues = { ...this.whereValues, ...criteria };
    return this;
  }

  /** Синоним where() для читаемости цепочек. */
  andWhere(criteria: Record<string, any>): this {
    return this.where(criteria);
  }

  /**
   * Добавить условие, объединённое с предыдущими через OR.
   * Формирует объектный оператор $or, поддерживаемый buildWhere.
   */
  orWhere(criteria: Record<string, any>): this {
    const existing = this.whereValues.$or;
    const currentOr = Array.isArray(existing)
      ? existing
      : existing !== undefined
        ? [existing]
        : [];
    this.whereValues = {
      ...this.whereValues,
      $or: [...currentOr, criteria],
    };
    return this;
  }

  /**
   * Добавить условие JSON_EXISTS для JSON-колонки.
   * Колонка должна быть объявлена как `@YdbColumn('Json')`, `@YdbColumn('JsonDocument')`
   * или `@YdbJson()`.
   */
  andWhereJsonExists(column: string, path: string): this {
    this.whereValues = {
      ...this.whereValues,
      [column]: { $jsonExists: path },
    };
    return this;
  }

  /**
   * Добавить условие JSON_VALUE = значение для JSON-колонки.
   * Значение сравнивается как строка (Utf8).
   */
  andWhereJsonValue(column: string, path: string, value: any): this {
    this.whereValues = {
      ...this.whereValues,
      [column]: { $jsonValue: { path, equals: value } },
    };
    return this;
  }

  orderBy(field: string, direction: OrderDirection = 'ASC'): this {
    this.orderClauses = [
      { field, direction: this.normalizeDirection(direction) },
    ];
    return this;
  }

  addOrderBy(field: string, direction: OrderDirection = 'ASC'): this {
    this.orderClauses.push({
      field,
      direction: this.normalizeDirection(direction),
    });
    return this;
  }

  /**
   * Рантайм-валидация направления сортировки: trim + uppercase,
   * whitelist ASC|DESC. Защита от SQL-инъекции через direction,
   * переданный как any/из JS в обход TS-типа OrderDirection.
   */
  private normalizeDirection(direction: unknown): OrderDirection {
    if (typeof direction !== 'string') {
      throw new Error(
        `Invalid ORDER BY direction: ${String(direction)}. Expected 'ASC' or 'DESC'.`,
      );
    }
    const normalized = direction.trim().toUpperCase();
    if (normalized !== 'ASC' && normalized !== 'DESC') {
      throw new Error(
        `Invalid ORDER BY direction: "${direction}". Allowed values: ASC, DESC.`,
      );
    }
    return normalized;
  }

  /** Указать конкретные колонки для SELECT (вместо SELECT *). */
  select(columns: string[]): this {
    this.selectColumns = columns;
    return this;
  }

  /**
   * Ограничить количество возвращаемых строк (LIMIT).
   *
   * Явная семантика (без молчаливого clamp в диапазон 1..1000):
   * - `limit(0)` — `LIMIT 0`: гарантированно пустой результат `[]`;
   * - положительное целое значение `n` — до `n` строк, сверху обрезается до
   *   MAX_RETRIEVE_LIMIT (защитный потолок);
   * - лимит вообще не задан — действует защитный дефолт
   *   DEFAULT_RETRIEVE_LIMIT (см. resolveLimit);
   * - отрицательное, дробное или неконечное значение — ошибка.
   *
   * Значение сохраняется в билдере и не меняется при выполнении:
   * getOne()/getMany()/toYql() его читают, но не перезаписывают.
   */
  limit(limit: number): this {
    this.limitValue = limit;
    return this;
  }

  offset(offset: number): this {
    this.offsetValue = offset;
    return this;
  }

  /** QueryOptions: trx, signal, timeout. limit/offset из билдера приоритетнее. */
  options(options: QueryOptions): this {
    this.queryOptions = options;
    return this;
  }

  /** Собирает SQL и значения параметров без выполнения. */
  async toYql(): Promise<BuiltQuery> {
    const { sql, values } = await this.build();
    return { sql, values };
  }

  /** Выполняет запрос и возвращает сущности (с eager relations). */
  async getMany(): Promise<T[]> {
    const { sql, values, keys, dbSchema } = await this.build();
    const rows = await this.entity._executeSelect(
      sql,
      values,
      keys,
      dbSchema,
      this.queryOptions,
    );
    return rows as T[];
  }

  /** Алиас getMany(). */
  execute(): Promise<T[]> {
    return this.getMany();
  }

  /**
   * Первая запись или null.
   *
   * Не мутирует исходный билдер: LIMIT 1 применяется к копии. Повторный
   * getMany()/toYql() на этом же билдере сохранит заданный пользователем лимит.
   */
  async getOne(): Promise<T | null> {
    const result = await this.clone().limit(1).getMany();
    return result[0] ?? null;
  }

  /** COUNT(*) по тем же условиям (без limit/offset/order). */
  async getCount(): Promise<number> {
    const meta = this.getMeta();
    const { whereClause, values, keys, dbSchema } =
      await this.entity._buildWhereClause(this.whereValues);
    const sql =
      `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(meta.tableName)}` +
      `${whereClause ? ` ${whereClause}` : ''}`;
    return this.entity._executeCount(
      sql,
      values,
      keys,
      dbSchema,
      this.queryOptions,
    );
  }

  /** Копия билдера: выполнение на копии не меняет состояние исходника. */
  private clone(): YdbQueryBuilder<T> {
    const copy = new YdbQueryBuilder<T>(this.entity);
    copy.whereValues = { ...this.whereValues };
    copy.orderClauses = this.orderClauses.map((o) => ({ ...o }));
    copy.limitValue = this.limitValue;
    copy.offsetValue = this.offsetValue;
    copy.selectColumns = this.selectColumns
      ? [...this.selectColumns]
      : undefined;
    copy.queryOptions = this.queryOptions;
    return copy;
  }

  private async build(): Promise<CompiledQuery> {
    const meta = this.getMeta();
    const { whereClause, values, keys, dbSchema } =
      await this.entity._buildWhereClause(this.whereValues);
    this.validateOrderFields(dbSchema);
    this.validateSelectFields(dbSchema);

    const orderClause = this.orderClauses.length
      ? ' ORDER BY ' +
        this.orderClauses
          .map((o) => `${quoteIdentifier(o.field)} ${o.direction}`)
          .join(', ')
      : '';

    const selectClause = this.selectColumns?.length
      ? this.selectColumns.map(quoteIdentifier).join(', ')
      : // Дефолтная проекция — только объявленные колонки (#164):
        // SELECT * утянул бы и столбцы, выпиленные из метаданных.
        Object.keys(meta.schema).map(quoteIdentifier).join(', ');

    const sql =
      `SELECT ${selectClause} FROM ${quoteIdentifier(meta.tableName)}` +
      `${whereClause ? ` ${whereClause}` : ''}${orderClause}` +
      ` LIMIT ${this.resolveLimit()} OFFSET ${this.resolveOffset()}`;

    return { sql, values, keys, dbSchema };
  }

  private getMeta() {
    const meta = getYdbEntityMetadata(this.entity);
    if (!meta) {
      throw new Error(
        `Class ${this.entity.name} is not decorated with @YdbEntity. ` +
          `Add @YdbEntity('table_name') to the class and declare its columns ` +
          `via @YdbColumn/@YdbPrimaryColumn.`,
      );
    }
    return meta;
  }

  private validateOrderFields(dbSchema: Record<string, YdbPrimitive>): void {
    for (const { field } of this.orderClauses) {
      if (!dbSchema[field]) {
        throw new Error(
          `Unknown field in ORDER BY: "${field}" on entity ` +
            `${this.entity.name}. Known fields: ${this.knownFields(dbSchema)}. ` +
            `Check for a typo in the property name.`,
        );
      }
    }
  }

  private validateSelectFields(dbSchema: Record<string, YdbPrimitive>): void {
    for (const field of this.selectColumns ?? []) {
      if (!dbSchema[field]) {
        throw new Error(
          `Unknown field in select: "${field}" on entity ` +
            `${this.entity.name}. Known fields: ${this.knownFields(dbSchema)}. ` +
            `Check for a typo in the property name.`,
        );
      }
    }
  }

  private knownFields(dbSchema: Record<string, YdbPrimitive>): string {
    return Object.keys(dbSchema).join(', ');
  }

  // Семантика LIMIT/OFFSET — общая с persistence (core/query-limits.ts):
  // limit() билдера приоритетнее queryOptions.limit; 0 → LIMIT 0;
  // отрицательные/дробные — ошибка; потолок MAX_RETRIEVE_LIMIT.
  private resolveLimit(): number {
    return resolveRetrieveLimit(this.limitValue ?? this.queryOptions?.limit);
  }

  private resolveOffset(): number {
    return resolveRetrieveOffset(this.offsetValue ?? this.queryOptions?.offset);
  }
}
