import type { YdbBaseEntity } from '../entity/base-entity.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import type { QueryOptions } from '../core/query-options.js';
import type { YdbPrimitive } from '../core/types.js';
import {
  resolveRetrieveLimit,
  resolveRetrieveOffset,
} from '../core/query-limits.js';

// The canonical constants live in core/query-limits.ts (single definition point
// of LIMIT/OFFSET semantics for the builder and persistence); re-export keeps
// the public API intact.
export {
  DEFAULT_RETRIEVE_LIMIT,
  MAX_RETRIEVE_LIMIT,
} from '../core/query-limits.js';

/** Sort direction for ORDER BY clauses. */
export type OrderDirection = 'ASC' | 'DESC';

/** Result of toYql(): the assembled SQL and parameter values (before mapping to YDB types). */
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
 * Chainable query builder over an Active Record entity.
 * where/andWhere conditions are equality-only and combined with AND
 * (repeating a field in andWhere overwrites the previous value). JSON
 * predicates (andWhereJsonExists/andWhereJsonValue) for the same column do
 * NOT overwrite each other — they compose via AND (#201).
 * Encrypted fields with a blind index are supported just like in find/findAll.
 *
 * The builder is reusable: builder methods (where/orderBy/limit/... ) and
 * execution methods (getMany/getOne/toYql) do not mutate each other's state.
 * The same builder can be executed multiple times — the result is identical.
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

  /** Adds equality conditions (AND). Repeated calls append to the conditions. */
  where(criteria: Record<string, any>): this {
    this.whereValues = { ...this.whereValues, ...criteria };
    return this;
  }

  /** Alias of where() for readable chains. */
  andWhere(criteria: Record<string, any>): this {
    return this.where(criteria);
  }

  /**
   * Adds a condition OR-ed with the ENTIRE accumulated predicate
   * (#173): `.where(A).orWhere(B)` yields `A OR B`, not `A AND (B)`.
   *
   * Repeated orWhere calls build a flat chain `A OR B OR C`; a subsequent
   * andWhere/where is combined via AND: `(A OR B OR C) AND D`.
   */
  orWhere(criteria: Record<string, any>): this {
    const keys = Object.keys(this.whereValues).filter(
      (key) => this.whereValues[key] !== undefined,
    );
    // No accumulated predicate — the first orWhere just sets the predicate.
    if (keys.length === 0) {
      this.whereValues = criteria;
      return this;
    }
    // The accumulated predicate is exactly $or: append to the existing list,
    // keeping the flat `A OR B OR C` chain without nesting.
    if (keys.length === 1 && keys[0] === '$or') {
      const existing = this.whereValues.$or;
      const list = Array.isArray(existing) ? existing : [existing];
      this.whereValues = { $or: [...list, criteria] };
      return this;
    }
    this.whereValues = { $or: [this.whereValues, criteria] };
    return this;
  }

  /**
   * Adds a JSON_EXISTS condition for a JSON column (#201).
   * The column must be declared as `@YdbColumn('Json')`, `@YdbColumn('JsonDocument')`
   * or `@YdbJson()`.
   *
   * Multiple JSON predicates for the same column are preserved and combined
   * via AND (`$and` composition), not overwriting each other.
   */
  andWhereJsonExists(column: string, path: string): this {
    return this.appendJsonCondition(column, { $jsonExists: path });
  }

  /**
   * Adds a JSON_VALUE = value condition for a JSON column (#201).
   * The value is compared as a string (Utf8).
   *
   * Multiple JSON predicates for the same column are preserved and combined
   * via AND (`$and` composition), not overwriting each other.
   */
  andWhereJsonValue(column: string, path: string, value: any): this {
    return this.appendJsonCondition(column, {
      $jsonValue: { path, equals: value },
    });
  }

  /**
   * Accumulates a JSON predicate for a column (#201). An existing predicate
   * for the same column is not overwritten: the first is stored as-is, every
   * subsequent one is appended via `$and` (explicit AND semantics).
   */
  private appendJsonCondition(
    column: string,
    predicate: Record<string, any>,
  ): this {
    const existing: unknown = this.whereValues[column];
    const isJsonGroup =
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      Object.keys(existing).length === 1 &&
      Array.isArray((existing as { $and: unknown }).$and);
    let next: unknown;
    if (existing === undefined) {
      next = predicate;
    } else if (isJsonGroup) {
      // Already-accumulated group — append to the flat `$and` list.
      const members = (existing as { $and: unknown[] }).$and;
      next = { $and: [...members, predicate] };
    } else {
      // Any previous value of the same column is preserved into the group.
      next = { $and: [existing, predicate] };
    }
    this.whereValues = { ...this.whereValues, [column]: next };
    return this;
  }

  /** Sets the ORDER BY clause, replacing any previously set order. */
  orderBy(field: string, direction: OrderDirection = 'ASC'): this {
    this.orderClauses = [
      { field, direction: this.normalizeDirection(direction) },
    ];
    return this;
  }

  /** Appends an additional ORDER BY clause. */
  addOrderBy(field: string, direction: OrderDirection = 'ASC'): this {
    this.orderClauses.push({
      field,
      direction: this.normalizeDirection(direction),
    });
    return this;
  }

  /**
   * Runtime validation of the sort direction: trim + uppercase,
   * whitelist ASC|DESC. Protects against SQL injection via a direction
   * passed as any/from JS, bypassing the TS OrderDirection type.
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

  /**
   * Selects specific columns for the query (instead of SELECT *).
   *
   * Empty-projection semantics (#202): `select([])` is explicitly rejected
   * with an error rather than silently falling back to the default
   * projection. Omitting `select()` keeps the default projection of all
   * declared columns (#164).
   */
  select(columns: string[]): this {
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new Error(
        `Invalid select: expected a non-empty array of column names. ` +
          `Received ${JSON.stringify(columns)}. ` +
          `To use the default projection, omit select() entirely.`,
      );
    }
    this.selectColumns = columns;
    return this;
  }

  /**
   * Limits the number of returned rows (LIMIT).
   *
   * Explicit semantics (no silent clamp into the 1..1000 range):
   * - `limit(0)` — `LIMIT 0`: guaranteed empty result `[]`;
   * - positive integer `n` — up to `n` rows, capped at
   *   MAX_RETRIEVE_LIMIT (safety ceiling);
   * - limit not set — the safety default DEFAULT_RETRIEVE_LIMIT applies
   *   (see resolveLimit);
   * - negative, fractional or non-finite value — error.
   *
   * The value is stored on the builder and does not change during execution:
   * getOne()/getMany()/toYql() read it but never overwrite it.
   */
  limit(limit: number): this {
    this.limitValue = limit;
    return this;
  }

  /** Sets the offset for the query. Fractional values are floored; negatives become 0. */
  offset(offset: number): this {
    this.offsetValue = offset;
    return this;
  }

  /** QueryOptions: trx, signal, timeout. Builder limit/offset take precedence. */
  options(options: QueryOptions): this {
    this.queryOptions = options;
    return this;
  }

  /** Assembles the SQL and parameter values without executing. */
  async toYql(): Promise<BuiltQuery> {
    const { sql, values } = await this.build();
    return { sql, values };
  }

  /** Executes the query and returns entities (with eager relations). */
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

  /** Alias of getMany(). */
  execute(): Promise<T[]> {
    return this.getMany();
  }

  /**
   * Returns the first row or null.
   *
   * Does not mutate the source builder: LIMIT 1 is applied to a clone.
   * A later getMany()/toYql() on the same builder keeps the user-set limit.
   */
  async getOne(): Promise<T | null> {
    const result = await this.clone().limit(1).getMany();
    return result[0] ?? null;
  }

  /** COUNT(*) over the same conditions (ignores limit/offset/order). */
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

  /** Clone of the builder: executing the clone does not change the source's state. */
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
      : // Default projection — only declared columns (#164):
        // SELECT * would also pull columns removed from the metadata.
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

  // LIMIT/OFFSET semantics are shared with persistence (core/query-limits.ts):
  // builder limit() takes precedence over queryOptions.limit; 0 → LIMIT 0;
  // negative/fractional → error; ceiling MAX_RETRIEVE_LIMIT.
  private resolveLimit(): number {
    return resolveRetrieveLimit(this.limitValue ?? this.queryOptions?.limit);
  }

  private resolveOffset(): number {
    return resolveRetrieveOffset(this.offsetValue ?? this.queryOptions?.offset);
  }
}
