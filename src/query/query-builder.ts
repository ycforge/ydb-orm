import type { YdbBaseEntity } from '../entity/base-entity.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import type { QueryOptions } from '../core/query-options.js';
import type { YdbPrimitive } from '../core/types.js';

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

  /** Первая запись или null. */
  async getOne(): Promise<T | null> {
    const result = await this.limit(1).getMany();
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
      : '*';

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

  private resolveLimit(): number {
    const value = this.limitValue ?? this.queryOptions?.limit;
    const num = Number.isFinite(value) ? Math.floor(value as number) : 100;
    return Math.max(1, Math.min(num, 1000));
  }

  private resolveOffset(): number {
    const value = this.offsetValue ?? this.queryOptions?.offset;
    const num = Number.isFinite(value) ? Math.floor(value as number) : 0;
    return Math.max(0, num);
  }
}
