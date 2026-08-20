import type { YdbExecutor, YdbQuery } from '../core/interfaces.js';
import {
  getYdbEntityMetadata,
  type EncryptedFieldMeta,
  type YdbEntityMetadata,
} from '../metadata/entity-metadata.js';
import { mapToYdb } from '../core/mapper.js';
import { v7 as uuidv7 } from 'uuid';
import type { QueryOptions } from '../core/query-options.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import { getEagerRelations } from '../decorators/eager.decorator.js';
import {
  YdbEncryptionContext,
  YdbEncryptionProvider,
  YdbBlindIndexProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import {
  YDB_CREATE_DATE_KEY,
  YDB_UPDATE_DATE_KEY,
} from '../decorators/timestamp.decorator.js';
import { getLifecycleHooks } from '../decorators/lifecycle.decorator.js';
import type { YdbPrimitive } from '../core/types.js';
import {
  getYdbEnumMetadata,
  type YdbEnumMeta,
} from '../decorators/enum.decorator.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import { YdbQueryBuilder } from '../query/query-builder.js';
import type { YdbBaseEntity } from '../entity/base-entity.js';

/**
 * Конструктор сущности, совместимый с YdbBaseEntity.
 */
export type YdbEntityConstructor<T extends YdbBaseEntity> = {
  new (): T;
} & typeof YdbBaseEntity;

/**
 * Зависимости persistence: executor и опциональные провайдеры.
 */
export interface PersistenceDeps {
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  validationProvider?: YdbValidationProvider;
  uuidGenerator?: () => string;
}

/**
 * Состояние lazy-дешифровки инстансов: поле → ciphertext из БД.
 * Записывается при instantiate(); снимается после decryptField().
 * WeakMap — не мешает сборке мусора и не виден в Object.entries/toJSON.
 */
const lazyPendingCiphertext = new WeakMap<object, Map<string, any>>();

/**
 * Проверяет, есть ли у инстанса недешифрованные lazy-поля.
 * Экспортируется для toJSON() в YdbBaseEntity.
 */
export function hasLazyPendingCiphertext(instance: object): boolean {
  const pending = lazyPendingCiphertext.get(instance);
  return (pending?.size ?? 0) > 0;
}

/**
 * Возвращает имена недешифрованных lazy-полей инстанса.
 */
export function getLazyPendingFieldNames(instance: object): string[] {
  const pending = lazyPendingCiphertext.get(instance);
  return pending ? [...pending.keys()] : [];
}

/**
 * Расширенная схема: entity поля + synthetic {field}_bi колонки.
 */
export function getEntityDbSchema(
  meta: YdbEntityMetadata,
): Record<string, YdbPrimitive> {
  const schema: Record<string, YdbPrimitive> = { ...meta.schema };
  for (const ef of meta.encryptedFields) {
    if (ef.blindIndex) schema[`${ef.propertyKey}_bi`] = 'Utf8';
  }
  return schema;
}

/**
 * Persistence-класс: все CRUD-операции, шифрование/дешифровка,
 * lifecycle hooks, enum-конвертация, timestamp-автопростановка.
 */
export class YdbEntityPersistence<T extends YdbBaseEntity> {
  constructor(
    public readonly entityClass: YdbEntityConstructor<T>,
    private executor: YdbExecutor | undefined,
    private readonly options: PersistenceDeps = {},
  ) {}

  /** Обновляет executor (вызывается из runtime при смене deps). */
  setExecutor(executor: YdbExecutor | undefined): void {
    this.executor = executor;
  }

  private getMeta(): YdbEntityMetadata {
    const meta = getYdbEntityMetadata(this.entityClass);
    if (!meta) {
      throw new Error(
        `Entity ${this.entityClass.name} is not decorated with @YdbEntity. ` +
          `Add @YdbEntity('table_name') to the class and declare its columns ` +
          `via @YdbColumn/@YdbPrimaryColumn.`,
      );
    }
    return meta;
  }

  private getExecutor(trx?: YdbExecutor): YdbExecutor {
    const db = trx ?? this.executor;
    if (!db) {
      throw new Error(
        `YDB executor not set for entity ${this.entityClass.name}. ` +
          `Register the entity via YdbModule.forFeature([${this.entityClass.name}]) (NestJS) ` +
          `or pass it to configureEntities([${this.entityClass.name}], { executor }) (standalone).`,
      );
    }
    return db;
  }

  private getEncryptionProvider(): YdbEncryptionProvider | undefined {
    return this.options.encryptionProvider;
  }

  private getBlindIndexProvider(): YdbBlindIndexProvider | undefined {
    return this.options.blindIndexProvider;
  }

  private getValidationProvider(): YdbValidationProvider | undefined {
    return this.options.validationProvider;
  }

  private requireEncryptionProvider(): YdbEncryptionProvider {
    const provider = this.getEncryptionProvider();
    if (!provider) {
      throw new Error(
        `Encryption provider is not configured for entity ${this.entityClass.name} ` +
          `but it has @YdbEncrypted fields. Pass "encryptionProvider" ` +
          `in YdbCoreModule.forRootAsync() options or configureEntities().`,
      );
    }
    return provider;
  }

  private requireBlindIndexProvider(): YdbBlindIndexProvider {
    const provider = this.getBlindIndexProvider();
    if (!provider) {
      throw new Error(
        `Blind index provider is not configured for entity ${this.entityClass.name} ` +
          `but it has @YdbEncrypted({ blindIndex: true }) fields. ` +
          `Pass "blindIndexProvider" in YdbCoreModule.forRootAsync() options ` +
          `or configureEntities().`,
      );
    }
    return provider;
  }

  private generateUuid(): string {
    return this.options.uuidGenerator?.() ?? uuidv7();
  }

  private getCreateDateColumn(): string | undefined {
    return Reflect.getMetadata(YDB_CREATE_DATE_KEY, this.entityClass) as
      string | undefined;
  }

  private getUpdateDateColumn(): string | undefined {
    return Reflect.getMetadata(YDB_UPDATE_DATE_KEY, this.entityClass) as
      string | undefined;
  }

  private knownFields(meta: YdbEntityMetadata): string {
    return Object.keys(meta.schema).join(', ');
  }

  private validateSelectFields(
    select: string[] | undefined,
    meta: YdbEntityMetadata,
  ): void {
    if (!select?.length) return;
    for (const field of select) {
      if (!meta.schema[field]) {
        throw new Error(
          `Unknown field in select: "${field}" on entity ${this.entityClass.name}. ` +
            `Known fields: ${this.knownFields(meta)}. ` +
            `Check for a typo in the property name.`,
        );
      }
    }
  }

  /**
   * PK-поля сущности: из метаданных (поддерживается составной PK).
   * Бросает ошибку, если первичный ключ не объявлен через @YdbPrimaryColumn.
   */
  getPkFields(meta: YdbEntityMetadata): string[] {
    if (meta.primaryKeys.length === 0) {
      throw new Error(
        `Entity ${this.entityClass.name} must declare at least one primary key via @YdbPrimaryColumn`,
      );
    }
    return meta.primaryKeys;
  }

  /**
   * Проверяет, что все компоненты PK заданы в объекте, и возвращает
   * фильтр { pkField: value }. Бросает понятную ошибку, если какой-то
   * компонент отсутствует (undefined/null).
   */
  requirePkValues(
    meta: YdbEntityMetadata,
    source: Record<string, any>,
    action: string,
  ): Record<string, any> {
    const pkFields = this.getPkFields(meta);
    const missing = pkFields.filter(
      (f) => source[f] === undefined || source[f] === null,
    );
    if (missing.length) {
      throw new Error(
        `Cannot ${action} ${this.entityClass.name}: primary key field(s) ${missing
          .map((f) => `"${f}"`)
          .join(', ')} must be set`,
      );
    }
    const filter: Record<string, any> = {};
    for (const f of pkFields) filter[f] = source[f];
    return filter;
  }

  /**
   * Строковое представление PK для контекста шифрования:
   * значения всех компонентов, соединённые через ':'.
   */
  pkValueForContext(
    meta: YdbEntityMetadata,
    source: Record<string, any>,
  ): string | undefined {
    const parts = this.getPkFields(meta)
      .map((f) => source[f])
      .filter((v) => v !== undefined && v !== null);
    return parts.length ? parts.map(String).join(':') : undefined;
  }

  private convertEnumOut(value: any, enumMeta: YdbEnumMeta | undefined): any {
    if (!enumMeta || value === null || value === undefined) return value;
    const str = String(value);
    if (!enumMeta.values.includes(str)) {
      throw new Error(
        `Invalid enum value "${value}" for field "${enumMeta.propertyKey}". Allowed: ${enumMeta.values.join(', ')}`,
      );
    }
    return enumMeta.storage === 'Int32' ? enumMeta.values.indexOf(str) : str;
  }

  private convertEnumIn(value: any, enumMeta: YdbEnumMeta | undefined): any {
    if (!enumMeta || value === null || value === undefined) return value;
    if (enumMeta.storage === 'Int32') {
      const index = Number(value);
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < enumMeta.values.length
      ) {
        return enumMeta.values[index];
      }
      return value;
    }
    return value;
  }

  private convertJsonOut(key: string, value: any): any {
    if (value === null || value === undefined) return value;
    const meta = this.getMeta();
    const dbSchema = getEntityDbSchema(meta);
    const dbType = dbSchema[key];
    if (
      meta.jsonColumns.includes(key) ||
      dbType === 'Json' ||
      dbType === 'JsonDocument'
    ) {
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
    return value;
  }

  private convertJsonIn(key: string, value: any): any {
    if (value === null || value === undefined) return value;
    const meta = this.getMeta();
    const dbSchema = getEntityDbSchema(meta);
    const dbType = dbSchema[key];
    if (
      meta.jsonColumns.includes(key) ||
      dbType === 'Json' ||
      dbType === 'JsonDocument'
    ) {
      return typeof value === 'string' ? JSON.parse(value) : value;
    }
    return value;
  }

  private bindParams(
    query: any,
    data: Record<string, any>,
    keys: string[],
    dbSchema: Record<string, YdbPrimitive>,
  ): void {
    const meta = this.getMeta();
    const effectiveSchema = dbSchema ?? meta.schema;
    const enums = getYdbEnumMetadata(this.entityClass);
    for (const k of keys) {
      const type = effectiveSchema[k];
      let value = data[k];
      if (!type) throw new Error(`No schema for field: ${k}`);
      const enumMeta = enums.find((e) => e.propertyKey === k);
      value = this.convertEnumOut(value, enumMeta);
      value = this.convertJsonOut(k, value);
      query.parameter(k, mapToYdb(type, value));
    }
  }

  private buildAAD(
    entity: Record<string, any>,
    aadFieldNames: string[],
  ): string {
    return aadFieldNames
      .filter((name) => entity[name] !== undefined && entity[name] !== null)
      .map((name) => `${name}=${entity[name]}`)
      .join(';');
  }

  /**
   * Возвращает копию сущности с зашифрованными полями и _bi колонками.
   * Исходный объект не мутируется: он должен хранить plaintext, иначе
   * повторный save() зашифрует ciphertext повторно.
   * Null/undefined не шифруются.
   *
   * Lazy-поля: если инстанс пришёл из БД и поле не менялось (в нём всё ещё
   * ciphertext), оно прокидывается как есть — повторное шифрование и
   * пересчёт blind index не нужны. Если пользователь присвоил новое
   * значение, оно шифруется как обычный plaintext.
   */
  async encryptEntity(
    entity: Record<string, any>,
    source?: object,
  ): Promise<Record<string, any>> {
    const meta = this.getMeta();
    if (!meta.encryptedFields.length) return entity;

    const encryptionProvider = this.requireEncryptionProvider();

    const baseContext: YdbEncryptionContext = {
      entityName: this.entityClass.name,
      tableName: meta.tableName,
      fieldName: '',
      primaryKeyValue: this.pkValueForContext(meta, entity),
      aadFields: {},
    };

    const aadFields: Record<string, string> = {};
    for (const aadName of meta.aadFields) {
      const av = entity[aadName];
      if (av !== undefined && av !== null) aadFields[aadName] = String(av);
    }

    const pendingLazy = source ? lazyPendingCiphertext.get(source) : undefined;

    const encrypted = { ...entity };
    for (const ef of meta.encryptedFields) {
      const value = entity[ef.propertyKey];
      if (value === null || value === undefined) continue;

      if (ef.lazy && pendingLazy?.get(ef.propertyKey) === value) {
        encrypted[ef.propertyKey] = value;
        continue;
      }

      const aad = ef.aadOverride ?? this.buildAAD(entity, meta.aadFields);
      const context: YdbEncryptionContext = {
        ...baseContext,
        fieldName: ef.propertyKey,
        aadFields,
      };

      encrypted[ef.propertyKey] = await encryptionProvider.encrypt(
        String(value),
        aad,
        context,
      );

      if (ef.blindIndex) {
        const provider = this.requireBlindIndexProvider();
        encrypted[`${ef.propertyKey}_bi`] = await provider.hash(String(value), {
          ...baseContext,
          fieldName: ef.propertyKey,
        });
      }
    }
    return encrypted;
  }

  /** Дешифрует поля в результате запроса. Null/undefined и lazy-поля пропускаются. */
  async decryptResult(
    result: Record<string, any> | Record<string, any>[] | null,
  ): Promise<void> {
    if (!result) return;
    const rows: Record<string, any>[] = Array.isArray(result)
      ? result
      : [result];

    const encryptionProvider = this.getEncryptionProvider();
    if (!encryptionProvider) return;

    const meta = this.getMeta();

    for (const row of rows) {
      const aadFields: Record<string, string> = {};
      for (const aadName of meta.aadFields) {
        const av = row[aadName];
        if (av !== undefined && av !== null) aadFields[aadName] = String(av);
      }

      for (const ef of meta.encryptedFields) {
        if (ef.lazy) continue;
        const ct = row[ef.propertyKey];
        if (ct === null || ct === undefined) continue;

        const aad = ef.aadOverride ?? this.buildAAD(row, meta.aadFields);
        row[ef.propertyKey] = await encryptionProvider.decrypt(
          ct as Uint8Array,
          aad,
          {
            entityName: this.entityClass.name,
            tableName: meta.tableName,
            fieldName: ef.propertyKey,
            primaryKeyValue: this.pkValueForContext(meta, row),
            aadFields,
          },
        );
      }
    }
  }

  /**
   * Преобразует WHERE: зашифрованные поля → {field}_bi колонки через blind index hash.
   */
  private async processWhere(
    where: Record<string, any>,
    meta: YdbEntityMetadata,
  ): Promise<{
    processedWhere: Record<string, any>;
    dbSchema: Record<string, YdbPrimitive>;
  }> {
    const encryptedByKey = new Map<
      EncryptedFieldMeta['propertyKey'],
      EncryptedFieldMeta
    >(meta.encryptedFields.map((ef) => [ef.propertyKey, ef]));
    const blindIndexProvider = this.getBlindIndexProvider();
    const processedWhere: Record<string, any> = {};

    for (const k of Object.keys(where)) {
      const ef = encryptedByKey.get(k);
      if (!ef) {
        processedWhere[k] = where[k];
        continue;
      }
      if (!ef.blindIndex) {
        throw new Error(
          `Cannot search by encrypted field "${k}" on entity ${this.entityClass.name}: ` +
            `blind index is disabled for it. ` +
            `Use @YdbEncrypted({ blindIndex: true }) to make it searchable.`,
        );
      }
      if (!blindIndexProvider) {
        throw new Error(
          `Blind index provider is not configured for entity ${this.entityClass.name} ` +
            `but it has @YdbEncrypted({ blindIndex: true }) fields. ` +
            `Pass "blindIndexProvider" in YdbCoreModule.forRootAsync() options ` +
            `or configureEntities().`,
        );
      }
      const value = where[k];
      if (value === undefined) continue;
      processedWhere[`${k}_bi`] = await blindIndexProvider.hash(String(value), {
        entityName: this.entityClass.name,
        tableName: meta.tableName,
        fieldName: k,
        primaryKeyValue: undefined,
        aadFields: {},
      });
    }

    return { processedWhere, dbSchema: getEntityDbSchema(meta) };
  }

  /**
   * Общий конвейер WHERE для find/findAll/count:
   * blind index → фильтрация undefined → валидация полей → WHERE-клауза.
   */
  async buildWhere(where: Record<string, any>): Promise<{
    whereClause: string;
    values: Record<string, any>;
    keys: string[];
    dbSchema: Record<string, YdbPrimitive>;
  }> {
    const meta = this.getMeta();
    const { processedWhere, dbSchema } = await this.processWhere(where, meta);
    const keys = Object.keys(processedWhere).filter(
      (k) => processedWhere[k] !== undefined,
    );
    for (const k of keys) {
      if (!dbSchema[k]) {
        throw new Error(
          `Unknown field in WHERE: "${k}" on entity ${this.entityClass.name}. ` +
            `Known fields: ${this.knownFields(meta)}. ` +
            `Check for a typo in the property name.`,
        );
      }
    }

    const conditions: string[] = [];
    const values: Record<string, any> = {};
    const paramKeys: string[] = [];
    const effectiveDbSchema = { ...dbSchema };

    for (const k of keys) {
      const value = processedWhere[k];
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        ('$jsonExists' in value || '$jsonValue' in value)
      ) {
        if ('$jsonExists' in value) {
          const paramName = `${k}__jsonexists`;
          conditions.push(`JSON_EXISTS(${quoteIdentifier(k)}, $${paramName})`);
          values[paramName] = value.$jsonExists;
          paramKeys.push(paramName);
          effectiveDbSchema[paramName] = 'Utf8';
        } else {
          const { path, equals } = value.$jsonValue as {
            path: string;
            equals: any;
          };
          const pathParam = `${k}__jsonvalue_path`;
          const valParam = `${k}__jsonvalue_val`;
          conditions.push(
            `JSON_VALUE(${quoteIdentifier(k)}, $${pathParam}) = $${valParam}`,
          );
          values[pathParam] = path;
          values[valParam] = equals;
          paramKeys.push(pathParam, valParam);
          effectiveDbSchema[pathParam] = 'Utf8';
          effectiveDbSchema[valParam] = 'Utf8';
        }
      } else {
        conditions.push(`${quoteIdentifier(k)} = $${k}`);
        values[k] = value;
        paramKeys.push(k);
      }
    }

    return {
      whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      values,
      keys: paramKeys,
      dbSchema: effectiveDbSchema,
    };
  }

  private async executeQuery<U>(
    query: YdbQuery,
    options?: QueryOptions,
  ): Promise<U> {
    const { signal, timeout } = options ?? {};

    if (signal) {
      if (signal.aborted) throw new Error('Query aborted by signal');
      query.signal(signal);
    }

    if (timeout && timeout > 0) {
      query.timeout(timeout);
    }

    return (await query) as U;
  }

  private resolveLimit(limit?: number): number {
    const value = Number.isFinite(limit) ? Math.floor(limit as number) : 100;
    return Math.max(1, Math.min(value, 1000));
  }

  private resolveOffset(offset?: number): number {
    const value = Number.isFinite(offset) ? Math.floor(offset as number) : 0;
    return Math.max(0, value);
  }

  /**
   * Создаёт инстанс сущности из строки БД.
   * Synthetic {field}_bi колонки (blind index) в инстанс не попадают.
   */
  instantiate(row: Record<string, any>): T {
    const meta = this.getMeta();
    const Ctor = this.entityClass as new () => T;
    const instance = new Ctor();
    const enums = getYdbEnumMetadata(this.entityClass);
    for (const [key, value] of Object.entries(row)) {
      if (isSyntheticColumn(meta, key)) continue;
      const enumMeta = enums.find((e) => e.propertyKey === key);
      let converted = this.convertEnumIn(value, enumMeta);
      converted = this.convertJsonIn(key, converted);
      (instance as any)[key] = converted;
    }

    const lazyFields = meta.encryptedFields.filter((ef) => ef.lazy);
    if (lazyFields.length) {
      const pending = new Map<string, any>();
      for (const ef of lazyFields) {
        const value = (instance as any)[ef.propertyKey];
        if (value !== null && value !== undefined) {
          pending.set(ef.propertyKey, value);
        }
      }
      if (pending.size) lazyPendingCiphertext.set(instance, pending);
    }
    return instance;
  }

  private async callHooks(
    phase: keyof ReturnType<typeof getLifecycleHooks>,
    instance: any,
  ): Promise<void> {
    const hooks = getLifecycleHooks(this.entityClass);
    const methods = hooks[phase];
    for (const methodName of methods) {
      const fn = instance[methodName];
      if (typeof fn === 'function') {
        await fn.call(instance);
      }
    }
  }

  private async runValidation(entity: Record<string, any>): Promise<void> {
    const provider = this.getValidationProvider();
    if (!provider) return;
    const errors = await provider.validate(entity);
    if (errors.length) {
      throw new Error(
        `Validation failed for ${this.entityClass.name}: ${errors.join('; ')}`,
      );
    }
  }

  async find(
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    this.validateSelectFields(options?.select, meta);

    const { whereClause, values, keys, dbSchema } =
      await this.buildWhere(where);
    if (!keys.length) {
      throw new Error(
        `find() on ${this.entityClass.name} requires at least one condition. ` +
          `Use findAll() to query without filters.`,
      );
    }

    const selectClause = options?.select?.length
      ? options.select.map(quoteIdentifier).join(', ')
      : '*';
    const sql = `SELECT ${selectClause} FROM ${quoteIdentifier(meta.tableName)} ${whereClause} LIMIT 1`;

    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    const raw = rows[0]?.[0] ?? null;
    if (!raw) return null;

    await this.decryptResult(raw);

    const result = this.instantiate(raw);

    await this.loadEagerRelations([result], options);

    await this.callHooks('afterFind', result);

    return result;
  }

  async findAll(
    where: Record<string, any> = {},
    options?: QueryOptions,
  ): Promise<T[]> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    this.validateSelectFields(options?.select, meta);

    const { whereClause, values, keys, dbSchema } =
      await this.buildWhere(where);
    const selectClause = options?.select?.length
      ? options.select.map(quoteIdentifier).join(', ')
      : '*';
    const sql = `SELECT ${selectClause} FROM ${quoteIdentifier(meta.tableName)} ${whereClause} LIMIT ${this.resolveLimit(options?.limit)} OFFSET ${this.resolveOffset(options?.offset)}`;

    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    const raw = rows[0] ?? [];

    await this.decryptResult(raw);

    const result = raw.map((r) => this.instantiate(r));

    if (result.length) {
      await this.loadEagerRelations(result, options);
    }

    return result;
  }

  async count(
    where: Record<string, any> = {},
    options?: QueryOptions,
  ): Promise<number> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();

    const { whereClause, values, keys, dbSchema } =
      await this.buildWhere(where);
    const sql = `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(meta.tableName)} ${whereClause}`;

    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    return Number(rows[0]?.[0]?.cnt ?? 0);
  }

  async findOneBy(
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return this.find(where, options);
  }

  async findBy(
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.findAll(where, options);
  }

  query(): YdbQueryBuilder<T> {
    return new YdbQueryBuilder<T>(this.entityClass);
  }

  /** @internal Мост для YdbQueryBuilder. */
  async executeSelect(
    sql: string,
    values: Record<string, any>,
    keys: string[],
    dbSchema: Record<string, YdbPrimitive>,
    options?: QueryOptions,
  ): Promise<T[]> {
    const exec = this.getExecutor(options?.trx);
    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    const raw = rows[0] ?? [];

    await this.decryptResult(raw);

    const result = raw.map((r) => this.instantiate(r));
    if (result.length) {
      await this.loadEagerRelations(result, options);
    }
    return result;
  }

  /** @internal Мост для YdbQueryBuilder. */
  async executeCount(
    sql: string,
    values: Record<string, any>,
    keys: string[],
    dbSchema: Record<string, YdbPrimitive>,
    options?: QueryOptions,
  ): Promise<number> {
    const exec = this.getExecutor(options?.trx);
    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    return Number(rows[0]?.[0]?.cnt ?? 0);
  }

  async save(entity: T, options?: QueryOptions): Promise<T> {
    const meta = this.getMeta();
    const pkFields = this.getPkFields(meta);
    const hasPk = pkFields.every(
      (f) =>
        (entity as Record<string, any>)[f] !== undefined &&
        (entity as Record<string, any>)[f] !== null,
    );
    if (hasPk) {
      return this.update(entity, options);
    }
    return this.insert(entity, options);
  }

  private async insert(entity: T, options?: QueryOptions): Promise<T> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const { tableName, schema } = meta;
    const dbSchema = getEntityDbSchema(meta);

    if (schema['uuid'] && !(entity as any).uuid) {
      (entity as any).uuid = this.generateUuid();
    }

    const createDateCol = this.getCreateDateColumn();
    const updateDateCol = this.getUpdateDateColumn();
    if (createDateCol && (entity as any)[createDateCol] === undefined) {
      (entity as any)[createDateCol] = new Date();
    }
    if (updateDateCol && (entity as any)[updateDateCol] === undefined) {
      (entity as any)[updateDateCol] = new Date();
    }

    await this.callHooks('beforeInsert', entity);

    await this.runValidation(entity as Record<string, any>);

    this.requirePkValues(meta, entity as Record<string, any>, 'insert');

    const data = await this.encryptEntity(
      { ...(entity as Record<string, any>) },
      entity,
    );
    const keys = Object.keys(data).filter(
      (k) => data[k] !== undefined && dbSchema[k],
    );
    const columns = keys.map(quoteIdentifier).join(', ');
    const values = keys.map((k) => `$${k}`).join(', ');

    const sql = `UPSERT INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${values})`;

    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, data, keys, dbSchema);

    await this.executeQuery(query, options);

    await this.callHooks('afterInsert', entity);

    return entity;
  }

  private async update(entity: T, options?: QueryOptions): Promise<T> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const { tableName } = meta;
    const dbSchema = getEntityDbSchema(meta);
    const pkFields = this.getPkFields(meta);

    const updateDateCol = this.getUpdateDateColumn();
    if (updateDateCol) {
      (entity as any)[updateDateCol] = new Date();
    }

    await this.callHooks('beforeUpdate', entity);

    await this.runValidation(entity as Record<string, any>);

    const rawKeys = Object.keys(entity).filter(
      (k) =>
        !pkFields.includes(k) &&
        (entity as Record<string, any>)[k] !== undefined &&
        dbSchema[k],
    );
    if (!rawKeys.length) {
      throw new Error(
        `Cannot update ${this.entityClass.name}: no fields to update — ` +
          `entity contains only primary key and/or undefined values`,
      );
    }

    const data = await this.encryptEntity(
      { ...(entity as Record<string, any>) },
      entity,
    );
    const keys = Object.keys(data).filter(
      (k) => !pkFields.includes(k) && data[k] !== undefined && dbSchema[k],
    );
    const pkFilter = this.requirePkValues(meta, data, 'update');
    const setClause = keys
      .map((k) => `${quoteIdentifier(k)} = $${k}`)
      .join(', ');
    const whereClause = pkFields
      .map((f) => `${quoteIdentifier(f)} = $${f}`)
      .join(' AND ');

    const sql = `
      UPDATE ${quoteIdentifier(tableName)}
      SET ${setClause}
      WHERE ${whereClause}
      RETURNING *
    `;
    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, data, [...keys, ...pkFields], dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    const raw = rows[0]?.[0] ?? null;
    if (!raw) {
      const pkDescription = pkFields
        .map((f) => `${f}=${String(pkFilter[f])}`)
        .join(', ');
      throw new Error(
        `Entity ${this.entityClass.name} with ${pkDescription} not found — nothing to update`,
      );
    }
    await this.decryptResult(raw);
    return this.instantiate(raw);
  }

  async insertMany(entities: T[], options?: QueryOptions): Promise<T[]> {
    if (!entities.length) return [];

    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const { tableName } = meta;
    const dbSchema = getEntityDbSchema(meta);

    if (meta.schema['uuid']) {
      for (const e of entities) {
        if (!(e as any).uuid) (e as any).uuid = this.generateUuid();
      }
    }

    const createDateCol = this.getCreateDateColumn();
    const updateDateCol = this.getUpdateDateColumn();
    if (createDateCol || updateDateCol) {
      for (const e of entities) {
        if (createDateCol && (e as any)[createDateCol] === undefined) {
          (e as any)[createDateCol] = new Date();
        }
        if (updateDateCol && (e as any)[updateDateCol] === undefined) {
          (e as any)[updateDateCol] = new Date();
        }
      }
    }

    for (const e of entities) {
      this.requirePkValues(meta, e as Record<string, any>, 'insert');
    }

    const provider = this.getValidationProvider();
    if (provider) {
      for (const e of entities) {
        const errors = await provider.validate(e);
        if (errors.length) {
          throw new Error(
            `Validation failed for ${this.entityClass.name}: ${errors.join('; ')}`,
          );
        }
      }
    }

    const dataList = await Promise.all(
      entities.map((e) =>
        this.encryptEntity({ ...(e as Record<string, any>) }, e),
      ),
    );

    const BATCH_SIZE = 100;

    for (let start = 0; start < dataList.length; start += BATCH_SIZE) {
      const batch = dataList.slice(start, start + BATCH_SIZE);
      const groups = new Map<
        string,
        { keys: string[]; rows: Record<string, any>[] }
      >();

      for (const data of batch) {
        const keys = Object.keys(data)
          .filter((k) => data[k] !== undefined && dbSchema[k])
          .sort();
        const signature = keys.join(' ');
        const group = groups.get(signature);
        if (group) {
          group.rows.push(data);
        } else {
          groups.set(signature, { keys, rows: [data] });
        }
      }

      for (const { keys, rows } of groups.values()) {
        const columns = keys.map(quoteIdentifier).join(', ');
        const valueRows = rows.map(
          (_, i) => `(${keys.map((k) => `$${k}_${i}`).join(', ')})`,
        );

        const sql = `UPSERT INTO ${quoteIdentifier(tableName)} (${columns}) VALUES ${valueRows.join(', ')}`;

        const query = exec([sql] as unknown as TemplateStringsArray);

        rows.forEach((row, i) => {
          for (const k of keys) {
            const value = this.convertJsonOut(k, row[k]);
            query.parameter(`${k}_${i}`, mapToYdb(dbSchema[k], value));
          }
        });

        await this.executeQuery(query, options);
      }
    }

    return entities;
  }

  async updateBy(
    where: Record<string, any>,
    patch: Partial<Record<string, any>>,
    options?: QueryOptions,
  ): Promise<number> {
    if (!Object.keys(where).length) {
      throw new Error(
        `updateBy() on ${this.entityClass.name} requires at least one WHERE condition to prevent full-table update`,
      );
    }
    if (!Object.keys(patch).length) {
      throw new Error(
        `updateBy() on ${this.entityClass.name} requires at least one field in patch`,
      );
    }

    const collision = Object.keys(patch).filter((k) =>
      Object.prototype.hasOwnProperty.call(where, k),
    );
    if (collision.length) {
      throw new Error(
        `updateBy() on ${this.entityClass.name}: field(s) ${collision.map((k) => `"${k}"`).join(', ')} present in both where and patch`,
      );
    }

    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const { tableName } = meta;
    const dbSchema = getEntityDbSchema(meta);

    const updateDateCol = this.getUpdateDateColumn();
    const data = { ...patch };
    if (updateDateCol && data[updateDateCol] === undefined) {
      data[updateDateCol] = new Date();
    }

    const encryptedFieldsToProcess = meta.encryptedFields.filter((ef) =>
      Object.prototype.hasOwnProperty.call(data, ef.propertyKey),
    );
    if (encryptedFieldsToProcess.length) {
      const encryptionProvider = this.requireEncryptionProvider();
      for (const ef of encryptedFieldsToProcess) {
        const value = data[ef.propertyKey];
        if (value === null || value === undefined) continue;

        let aadFields: Record<string, string> = {};
        if (!ef.aadOverride && meta.aadFields.length) {
          const missingAadFields = meta.aadFields.filter(
            (f) => where[f] === undefined || where[f] === null,
          );
          if (missingAadFields.length) {
            throw new Error(
              `updateBy() on ${this.entityClass.name} cannot update encrypted field "${ef.propertyKey}": ` +
                `AAD field(s) ${missingAadFields.map((f) => `"${f}"`).join(', ')} ` +
                `are not fixed by the where predicate; set them in where or use aadOverride`,
            );
          }
          aadFields = Object.fromEntries(
            meta.aadFields.map((f) => [f, String(where[f])]),
          );
        }
        const aad = ef.aadOverride ?? this.buildAAD(aadFields, meta.aadFields);
        const context: YdbEncryptionContext = {
          entityName: this.entityClass.name,
          tableName: meta.tableName,
          fieldName: ef.propertyKey,
          primaryKeyValue: this.pkValueForContext(meta, where),
          aadFields,
        };

        data[ef.propertyKey] = await encryptionProvider.encrypt(
          String(value),
          aad,
          context,
        );

        if (ef.blindIndex) {
          const blindIndexProvider = this.requireBlindIndexProvider();
          data[`${ef.propertyKey}_bi`] = await blindIndexProvider.hash(
            String(value),
            { ...context, fieldName: ef.propertyKey },
          );
        }
      }
    }

    const setKeys = Object.keys(data).filter((k) => dbSchema[k]);
    for (const k of Object.keys(data)) {
      if (!dbSchema[k]) {
        throw new Error(
          `Unknown field in patch: "${k}" on entity ${this.entityClass.name}. ` +
            `Known fields: ${this.knownFields(meta)}. ` +
            `Check for a typo in the property name.`,
        );
      }
    }
    if (!setKeys.length) {
      throw new Error(
        `updateBy() on ${this.entityClass.name}: no valid fields in patch`,
      );
    }

    const setClause = setKeys
      .map((k) => `${quoteIdentifier(k)} = $${k}`)
      .join(', ');

    const {
      whereClause,
      values: whereValues,
      keys: whereKeys,
      dbSchema: whereDbSchema,
    } = await this.buildWhere(where);
    if (!whereKeys.length) {
      throw new Error(
        `updateBy() on ${this.entityClass.name} has no effective WHERE condition ` +
          `(all values are undefined) — refusing full-table update`,
      );
    }

    const allValues: Record<string, any> = { ...whereValues };
    for (const k of setKeys) {
      allValues[k] = data[k];
    }
    const allKeys = [...whereKeys, ...setKeys];
    const allDbSchema = { ...whereDbSchema, ...dbSchema };

    const pkColumns = this.getPkFields(meta).map(quoteIdentifier).join(', ');
    const sql = `UPDATE ${quoteIdentifier(tableName)} SET ${setClause} ${whereClause} RETURNING ${pkColumns}`;
    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, allValues, allKeys, allDbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    return rows[0]?.length ?? 0;
  }

  async delete(
    pkValue: string | number | Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const dbSchema = getEntityDbSchema(meta);
    const pkFields = this.getPkFields(meta);

    for (const f of pkFields) {
      if (!dbSchema[f]) {
        throw new Error(
          `Cannot delete ${this.entityClass.name} by primary key: column "${f}" ` +
            `is not declared. Declare it via @YdbPrimaryColumn ` +
            `(or a "uuid" @YdbColumn).`,
        );
      }
    }
    const filter = this.requirePkValues(
      meta,
      typeof pkValue === 'object' && pkValue !== null
        ? pkValue
        : { [pkFields[0]]: pkValue },
      'delete',
    );

    if (getLifecycleHooks(this.entityClass).beforeRemove.length) {
      const entity = await this.find(filter, options);
      if (!entity) return null;
      await this.callHooks('beforeRemove', entity);
    }

    const paramName = (f: string) => (pkFields.length === 1 ? 'pk' : `pk_${f}`);
    const whereClause = pkFields
      .map((f) => `${quoteIdentifier(f)} = $${paramName(f)}`)
      .join(' AND ');
    const sql = `DELETE FROM ${quoteIdentifier(meta.tableName)} WHERE ${whereClause} RETURNING *`;
    const query = exec([sql] as unknown as TemplateStringsArray);
    for (const f of pkFields) {
      query.parameter(paramName(f), mapToYdb(dbSchema[f], filter[f]));
    }

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    const raw = rows[0]?.[0] ?? null;
    if (!raw) return null;

    await this.decryptResult(raw);
    return this.instantiate(raw);
  }

  async deleteBy(
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<number> {
    if (!Object.keys(where).length) {
      throw new Error(
        `deleteBy() on ${this.entityClass.name} requires at least one WHERE condition to prevent full-table delete`,
      );
    }

    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();

    const { whereClause, values, keys, dbSchema } =
      await this.buildWhere(where);
    if (!keys.length) {
      throw new Error(
        `deleteBy() on ${this.entityClass.name} has no effective WHERE condition ` +
          `(all values are undefined) — refusing full-table delete`,
      );
    }

    const pkColumns = this.getPkFields(meta).map(quoteIdentifier).join(', ');
    const sql = `DELETE FROM ${quoteIdentifier(meta.tableName)} ${whereClause} RETURNING ${pkColumns}`;
    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    return rows[0]?.length ?? 0;
  }

  /**
   * Дешифрует одно lazy-поле (@YdbEncrypted({ lazy: true })) на инстансе.
   * Идемпотентно: повторный вызов отдаёт закешированный plaintext.
   */
  async decryptField(instance: T, name: string): Promise<any> {
    const meta = this.getMeta();
    const ef = meta.encryptedFields.find(
      (f) => f.propertyKey === name && f.lazy,
    );
    if (!ef) {
      throw new Error(`Field "${name}" is not a lazy encrypted field`);
    }
    const pending = lazyPendingCiphertext.get(instance);
    if (!pending?.has(name)) {
      return (instance as any)[name];
    }

    const ciphertext = pending.get(name);
    if ((instance as any)[name] !== ciphertext) {
      pending.delete(name);
      if (!pending.size) lazyPendingCiphertext.delete(instance);
      return (instance as any)[name];
    }

    const provider = this.getEncryptionProvider();
    if (!provider) {
      throw new Error(
        `Encryption provider is not configured for entity ${this.entityClass.name} but lazy @YdbEncrypted fields exist`,
      );
    }

    const aadFields: Record<string, string> = {};
    for (const aadName of meta.aadFields) {
      const av = (instance as any)[aadName];
      if (av !== undefined && av !== null) aadFields[aadName] = String(av);
    }
    const pkField = this.getPkFields(meta)[0];
    const pkValue = (instance as any)[pkField];

    const plaintext = await provider.decrypt(
      ciphertext as Uint8Array,
      ef.aadOverride ??
        this.buildAAD(instance as Record<string, any>, meta.aadFields),
      {
        entityName: this.entityClass.name,
        tableName: meta.tableName,
        fieldName: name,
        primaryKeyValue:
          pkValue !== undefined && pkValue !== null
            ? String(pkValue)
            : undefined,
        aadFields,
      },
    );

    (instance as any)[name] = plaintext;
    pending.delete(name);
    if (!pending.size) lazyPendingCiphertext.delete(instance);
    return plaintext;
  }

  /**
   * Дешифрует все lazy-поля инстанса. Идемпотентно.
   */
  async decryptLazyFields(instance: T): Promise<T> {
    const meta = this.getMeta();
    const pending = lazyPendingCiphertext.get(instance);
    if (!pending) return instance;
    const names = meta.encryptedFields
      .filter((ef) => ef.lazy && pending.has(ef.propertyKey))
      .map((ef) => ef.propertyKey);
    await Promise.all(names.map((name) => this.decryptField(instance, name)));
    return instance;
  }

  // ---- Relations helpers (delegated to YdbEntityRelations at repository level) ----

  /**
   * Batch-загрузка по колонке IN (...). Используется relations-модулем.
   */
  async fetchByColumnIn(
    column: string,
    values: any[],
    options?: QueryOptions,
  ): Promise<T[]> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const columnType = meta.schema[column];
    if (!columnType) {
      throw new Error(
        `No schema for join column "${column}" on entity ${this.entityClass.name}`,
      );
    }

    const inParams = values.map((_, i) => `$p${i}`).join(', ');
    const sql = `SELECT * FROM ${quoteIdentifier(meta.tableName)} WHERE ${quoteIdentifier(column)} IN (${inParams})`;

    const query = exec([sql] as unknown as TemplateStringsArray);
    values.forEach((value, i) => {
      query.parameter(`p${i}`, mapToYdb(columnType, value));
    });

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    const raw = rows[0] ?? [];

    await this.decryptResult(raw);
    return raw.map((r) => this.instantiate(r));
  }

  /**
   * Загружает eager relations для списка сущностей.
   * Вызывается из find/findAll/executeSelect.
   */
  private async loadEagerRelations(
    items: T[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!items.length) return;

    const eager = getEagerRelations(this.entityClass);
    if (!eager.length) return;

    const relations = new (
      await import('../relations/entity-relations.js')
    ).YdbEntityRelations(this.entityClass, this.executor, {
      encryptionProvider: this.options.encryptionProvider,
      blindIndexProvider: this.options.blindIndexProvider,
    });
    await relations.loadEagerRelations(items, options);
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
