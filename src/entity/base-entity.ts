import type { YdbExecutor } from '../core/interfaces.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import type { YdbEntityMetadata } from '../metadata/entity-metadata.js';
import type { QueryOptions } from '../core/query-options.js';
import type { YdbPrimitive } from '../core/types.js';
import { getEntityRuntime } from './entity-runtime.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import type { AadFormat } from '../encryption/aad.js';
import { YdbQueryBuilder } from '../query/query-builder.js';
import { getOrCreateRepository } from '../repository/repository-resolver.js';
import {
  getEntityDbSchema,
  hasLazyPendingCiphertext,
  getLazyPendingFieldNames,
  isSyntheticColumn,
} from '../persistence/entity-persistence.js';

/**
 * Active Record base class.
 *
 * Contains only public static facades and instance helpers.
 * All CRUD/encryption/relations implementation lives in `YdbEntityPersistence`
 * and `YdbEntityRelations`, accessible via `YdbRepository` from entity-runtime.
 */
export class YdbBaseEntity {
  // ---- Runtime setters (public API for tests and standalone configuration) ----

  /**
   * Sets the executor. Passing undefined resets the executor
   * (needed for re-bootstrap and state cleanup in tests).
   */
  static setExecutor(this: typeof YdbBaseEntity, db?: YdbExecutor): void {
    getEntityRuntime(this).executor = db;
    this.clearRepository();
  }

  /**
   * Sets the encryption provider. Passing undefined resets
   * the provider (needed for re-bootstrap without encryption).
   */
  static setEncryptionProvider(
    this: typeof YdbBaseEntity,
    provider?: YdbEncryptionProvider,
  ): void {
    getEntityRuntime(this).encryptionProvider = provider;
    this.clearRepository();
  }

  /**
   * Sets the blind index provider. Passing undefined resets
   * the provider (needed for re-bootstrap without encryption).
   */
  static setBlindIndexProvider(
    this: typeof YdbBaseEntity,
    provider?: YdbBlindIndexProvider,
  ): void {
    getEntityRuntime(this).blindIndexProvider = provider;
    this.clearRepository();
  }

  /**
   * Sets the validation provider. Passing undefined resets
   * the provider (needed for re-bootstrap and state cleanup in tests).
   */
  static setValidationProvider(
    this: typeof YdbBaseEntity,
    provider?: YdbValidationProvider,
  ): void {
    getEntityRuntime(this).validationProvider = provider;
    this.clearRepository();
  }

  /**
   * Sets the Security AAD serialization format (#165): 'v2' (default,
   * secure) or 'legacy' — only for the transitional period when the
   * database still has ciphertext written in the old format. Passing
   * undefined returns the default format.
   */
  static setAadFormat(this: typeof YdbBaseEntity, format?: AadFormat): void {
    getEntityRuntime(this).aadFormat = format;
    this.clearRepository();
  }

  /**
   * Controls automatic AAD format detection on decryption (#165).
   * Default (undefined → true): on primary format failure, a second
   * attempt is made with the other format — records written in legacy
   * format are readable immediately after upgrading to v2 default.
   * After full data re-encryption, pass `false` — strict mode, format
   * error is not masked.
   */
  static setAadReadFallback(
    this: typeof YdbBaseEntity,
    fallback?: boolean,
  ): void {
    getEntityRuntime(this).aadReadFallback = fallback;
    this.clearRepository();
  }

  private static clearRepository(this: typeof YdbBaseEntity): void {
    getEntityRuntime(this).repository = undefined;
  }

  // ---- Metadata helpers ----

  protected static getMeta(this: typeof YdbBaseEntity): YdbEntityMetadata {
    const meta = getYdbEntityMetadata(this);
    if (!meta) {
      throw new Error(
        `Entity ${this.name} is not decorated with @YdbEntity. ` +
          `Add @YdbEntity('table_name') to the class and declare its columns ` +
          `via @YdbColumn/@YdbPrimaryColumn.`,
      );
    }
    return meta;
  }

  protected static getDbSchema(
    this: typeof YdbBaseEntity,
    meta?: YdbEntityMetadata,
  ): Record<string, YdbPrimitive> {
    return getEntityDbSchema(meta ?? this.getMeta());
  }

  // ---- CRUD facades ----

  /**
   * Finds a single entity by the given criteria.
   * @param where - Filter criteria (column-value pairs).
   * @param options - Query options (transaction, timeout, limit, offset, signal, idempotent).
   * @returns The entity instance or null if not found.
   */
  static async find<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return getOrCreateRepository<T>(this).find(where, options);
  }

  /**
   * Finds all entities matching the criteria.
   * @param where - Filter criteria (column-value pairs). Defaults to {} (all rows).
   * @param options - Query options (transaction, timeout, limit, offset, signal, idempotent).
   * @returns Array of entity instances.
   */
  static async findAll<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any> = {},
    options?: QueryOptions,
  ): Promise<T[]> {
    return getOrCreateRepository<T>(this).findAll(where, options);
  }

  /**
   * Finds a single entity by the given criteria (alias for `find`).
   * @param where - Filter criteria (column-value pairs).
   * @param options - Query options (transaction, timeout, limit, offset, signal, idempotent).
   * @returns The entity instance or null if not found.
   */
  static async findOneBy<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return getOrCreateRepository<T>(this).findOneBy(where, options);
  }

  /**
   * Finds all entities matching the criteria (alias for `findAll`).
   * @param where - Filter criteria (column-value pairs).
   * @param options - Query options (transaction, timeout, limit, offset, signal, idempotent).
   * @returns Array of entity instances.
   */
  static async findBy<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T[]> {
    return getOrCreateRepository<T>(this).findBy(where, options);
  }

  /**
   * Counts entities matching the criteria.
   * @param where - Filter criteria (column-value pairs). Defaults to {} (all rows).
   * @param options - Query options (transaction, timeout, signal, idempotent).
   * @returns Number of matching rows.
   */
  static async count(
    this: typeof YdbBaseEntity,
    where: Record<string, any> = {},
    options?: QueryOptions,
  ): Promise<number> {
    return getOrCreateRepository(this).count(where, options);
  }

  /**
   * Saves (inserts or updates) an entity instance.
   * @param entity - Entity instance to save.
   * @param options - Query options (transaction, timeout, signal, idempotent).
   * @returns The saved entity instance (with generated PK if applicable).
   */
  static async save<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    entity: T,
    options?: QueryOptions,
  ): Promise<T> {
    return getOrCreateRepository<T>(this).save(entity, options);
  }

  /**
   * Inserts multiple entities in a single batch (grouped by columns).
   * @param entities - Array of entity instances to insert.
   * @param options - Query options (transaction, timeout, signal, idempotent).
   * @returns Array of saved entity instances.
   */
  static async insertMany<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    entities: T[],
    options?: QueryOptions,
  ): Promise<T[]> {
    return getOrCreateRepository<T>(this).insertMany(entities, options);
  }

  /**
   * Updates entities matching the criteria with the given patch.
   * @param where - Filter criteria (column-value pairs).
   * @param patch - Partial object with columns to update.
   * @param options - Query options (transaction, timeout, signal, idempotent).
   * @returns Number of affected rows.
   */
  static async updateBy(
    this: typeof YdbBaseEntity,
    where: Record<string, any>,
    patch: Partial<Record<string, any>>,
    options?: QueryOptions,
  ): Promise<number> {
    return getOrCreateRepository(this).updateBy(where, patch, options);
  }

  /**
   * Deletes an entity by primary key value(s).
   * @param pkValue - Primary key value (single value for single PK, object for composite PK).
   * @param options - Query options (transaction, timeout, signal, idempotent).
   * @returns The deleted entity instance or null if not found.
   */
  static async delete<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    pkValue: string | number | Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return getOrCreateRepository<T>(this).delete(pkValue, options);
  }

  /**
   * Deletes all entities matching the criteria.
   * @param where - Filter criteria (column-value pairs).
   * @param options - Query options (transaction, timeout, signal, idempotent).
   * @returns Number of deleted rows.
   */
  static async deleteBy(
    this: typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<number> {
    return getOrCreateRepository(this).deleteBy(where, options);
  }

  /**
   * Returns a query builder for the entity.
   * @returns YdbQueryBuilder instance for fluent query construction.
   */
  static query<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
  ): YdbQueryBuilder<T> {
    return getOrCreateRepository<T>(this).query();
  }

  // ---- @internal bridges for YdbQueryBuilder ----

  /**
   * @internal Bridge for YdbQueryBuilder: build WHERE clause from entity metadata.
   */
  static _buildWhereClause(
    this: typeof YdbBaseEntity,
    where: Record<string, any>,
  ): Promise<{
    whereClause: string;
    values: Record<string, any>;
    keys: string[];
    dbSchema: Record<string, YdbPrimitive>;
  }> {
    return getOrCreateRepository(this).persistence.buildWhere(where);
  }

  /**
   * @internal Bridge for YdbQueryBuilder: execute SELECT and return entities.
   */
  static async _executeSelect<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    sql: string,
    values: Record<string, any>,
    keys: string[],
    dbSchema: Record<string, YdbPrimitive>,
    options?: QueryOptions,
  ): Promise<T[]> {
    return getOrCreateRepository<T>(this).persistence.executeSelect(
      sql,
      values,
      keys,
      dbSchema,
      options,
    );
  }

  /**
   * @internal Bridge for YdbQueryBuilder: execute COUNT query.
   */
  static async _executeCount(
    this: typeof YdbBaseEntity,
    sql: string,
    values: Record<string, any>,
    keys: string[],
    dbSchema: Record<string, YdbPrimitive>,
    options?: QueryOptions,
  ): Promise<number> {
    return getOrCreateRepository(this).persistence.executeCount(
      sql,
      values,
      keys,
      dbSchema,
      options,
    );
  }

  // ---- Instance helpers ----

  /**
   * Serialization to JSON: excludes synthetic {field}_bi columns
   * and internal service fields.
   */
  toJSON(): Record<string, any> {
    const meta = getYdbEntityMetadata(this.constructor as typeof YdbBaseEntity);
    if (hasLazyPendingCiphertext(this)) {
      const names = getLazyPendingFieldNames(this).join(', ');
      throw new Error(
        `Lazy encrypted field(s) not decrypted: ${names}. ` +
          `Call await entity.decryptLazyFields() before toJSON()/JSON.stringify()`,
      );
    }
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(this)) {
      if (meta && isSyntheticColumn(meta, key)) continue;
      result[key] = typeof value === 'bigint' ? String(value) : value;
    }
    return result;
  }

  async decryptField(name: string): Promise<any> {
    const constructor = this.constructor as typeof YdbBaseEntity;
    return getOrCreateRepository(constructor).persistence.decryptField(
      this,
      name,
    );
  }

  async decryptLazyFields(): Promise<this> {
    const constructor = this.constructor as typeof YdbBaseEntity;
    await getOrCreateRepository(constructor).persistence.decryptLazyFields(
      this,
    );
    return this;
  }

  async loadRelations(
    relations: string[],
    options?: QueryOptions,
  ): Promise<this> {
    const constructor = this.constructor as typeof YdbBaseEntity;
    await getOrCreateRepository(constructor).relations.loadRelations(
      [this],
      relations,
      options,
    );
    return this;
  }
}
