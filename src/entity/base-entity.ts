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
import { YdbQueryBuilder } from '../query/query-builder.js';
import { getOrCreateRepository } from '../repository/repository-resolver.js';
import {
  getEntityDbSchema,
  hasLazyPendingCiphertext,
  getLazyPendingFieldNames,
} from '../persistence/entity-persistence.js';

/**
 * Базовый класс Active Record.
 *
 * Содержит только публичные статические фасады и instance helpers.
 * Вся реализация CRUD/шифрования/relations живёт в `YdbEntityPersistence`
 * и `YdbEntityRelations`, доступных через `YdbRepository` из entity-runtime.
 */
export class YdbBaseEntity {
  // ---- Runtime setters (публичный API для тестов и standalone-конфигурации) ----

  /**
   * Устанавливает executor. Передача undefined сбрасывает executor
   * (нужно при повторном бутстрапе и очистке состояния в тестах).
   */
  static setExecutor(this: typeof YdbBaseEntity, db?: YdbExecutor): void {
    getEntityRuntime(this).executor = db;
    this.clearRepository();
  }

  /**
   * Устанавливает encryption-провайдер. Передача undefined сбрасывает
   * провайдер (нужно при повторном бутстрапе без шифрования).
   */
  static setEncryptionProvider(
    this: typeof YdbBaseEntity,
    provider?: YdbEncryptionProvider,
  ): void {
    getEntityRuntime(this).encryptionProvider = provider;
    this.clearRepository();
  }

  /**
   * Устанавливает blind-index-провайдер. Передача undefined сбрасывает
   * провайдер (нужно при повторном бутстрапе без шифрования).
   */
  static setBlindIndexProvider(
    this: typeof YdbBaseEntity,
    provider?: YdbBlindIndexProvider,
  ): void {
    getEntityRuntime(this).blindIndexProvider = provider;
    this.clearRepository();
  }

  static setValidationProvider(
    this: typeof YdbBaseEntity,
    provider: YdbValidationProvider,
  ): void {
    getEntityRuntime(this).validationProvider = provider;
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

  static async find<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return getOrCreateRepository<T>(this).find(where, options);
  }

  static async findAll<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any> = {},
    options?: QueryOptions,
  ): Promise<T[]> {
    return getOrCreateRepository<T>(this).findAll(where, options);
  }

  static async findOneBy<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return getOrCreateRepository<T>(this).findOneBy(where, options);
  }

  static async findBy<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T[]> {
    return getOrCreateRepository<T>(this).findBy(where, options);
  }

  static async count(
    this: typeof YdbBaseEntity,
    where: Record<string, any> = {},
    options?: QueryOptions,
  ): Promise<number> {
    return getOrCreateRepository(this).count(where, options);
  }

  static async save<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    entity: T,
    options?: QueryOptions,
  ): Promise<T> {
    return getOrCreateRepository<T>(this).save(entity, options);
  }

  static async insertMany<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    entities: T[],
    options?: QueryOptions,
  ): Promise<T[]> {
    return getOrCreateRepository<T>(this).insertMany(entities, options);
  }

  static async updateBy(
    this: typeof YdbBaseEntity,
    where: Record<string, any>,
    patch: Partial<Record<string, any>>,
    options?: QueryOptions,
  ): Promise<number> {
    return getOrCreateRepository(this).updateBy(where, patch, options);
  }

  static async delete<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    pkValue: string | number | Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return getOrCreateRepository<T>(this).delete(pkValue, options);
  }

  static async deleteBy(
    this: typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<number> {
    return getOrCreateRepository(this).deleteBy(where, options);
  }

  static query<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
  ): YdbQueryBuilder<T> {
    return getOrCreateRepository<T>(this).query();
  }

  // ---- @internal мосты для YdbQueryBuilder ----

  /**
   * @internal Мост для YdbQueryBuilder: собрать WHERE по метаданным сущности.
   */
  static _buildWhereClause(
    this: typeof YdbBaseEntity,
    where: Record<string, any>,
  ) {
    return getOrCreateRepository(this).persistence.buildWhere(where);
  }

  /**
   * @internal Мост для YdbQueryBuilder: выполнить SELECT и вернуть сущности.
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
   * @internal Мост для YdbQueryBuilder: выполнить COUNT-запрос.
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
   * Сериализация в JSON: исключает synthetic {field}_bi колонки
   * и внутренние служебные поля.
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

/** Проверяет, что колонка — synthetic blind index ({field}_bi) */
function isSyntheticColumn(meta: YdbEntityMetadata, key: string): boolean {
  return (
    key.endsWith('_bi') &&
    meta.encryptedFields.some(
      (ef) => ef.blindIndex && `${ef.propertyKey}_bi` === key,
    )
  );
}
