import { YdbExecutor, YdbQuery } from '../core/interfaces.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { mapToYdb } from '../core/mapper.js';
import { v7 as uuidv7 } from 'uuid';
import { QueryOptions } from '../core/query-options.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import {
  getYdbJoinTableMetadata,
  getYdbRelationsMetadata,
} from '../decorators/relation.decorators.js';
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
import type {
  EncryptedFieldMeta,
  YdbEntityMetadata,
} from '../metadata/entity-metadata.js';
import {
  getYdbEnumMetadata,
  type YdbEnumMeta,
} from '../decorators/enum.decorator.js';
import { getEntityRuntime } from './entity-runtime.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import { YdbQueryBuilder } from '../query/query-builder.js';

export class YdbBaseEntity {
  static setExecutor(db: YdbExecutor): void {
    getEntityRuntime(this).executor = db;
  }

  static setEncryptionProvider(provider: YdbEncryptionProvider): void {
    getEntityRuntime(this).encryptionProvider = provider;
  }

  static setBlindIndexProvider(provider: YdbBlindIndexProvider): void {
    getEntityRuntime(this).blindIndexProvider = provider;
  }

  static setValidationProvider(provider: YdbValidationProvider): void {
    getEntityRuntime(this).validationProvider = provider;
  }

  protected static getValidationProvider(): YdbValidationProvider | undefined {
    return getEntityRuntime(this).validationProvider;
  }

  protected static async runValidation(
    entity: Record<string, any>,
  ): Promise<void> {
    const provider = this.getValidationProvider();
    if (!provider) return;
    const errors = await provider.validate(entity);
    if (errors.length) {
      throw new Error(
        `Validation failed for ${this.name}: ${errors.join('; ')}`,
      );
    }
  }

  /**
   * Вызывает lifecycle hooks указанной фазы на экземпляре сущности.
   * Все хуки выполняются последовательно и awaitятся.
   */
  private static async callHooks(
    phase: keyof ReturnType<typeof getLifecycleHooks>,
    instance: any,
  ): Promise<void> {
    const hooks = getLifecycleHooks(this);
    const methods = hooks[phase];
    for (const methodName of methods) {
      const fn = instance[methodName];
      if (typeof fn === 'function') {
        await fn.call(instance);
      }
    }
  }

  protected static getEncryptionProvider(): YdbEncryptionProvider | undefined {
    return getEntityRuntime(this).encryptionProvider;
  }

  protected static getBlindIndexProvider(): YdbBlindIndexProvider | undefined {
    return getEntityRuntime(this).blindIndexProvider;
  }

  /** Encryption provider или понятная ошибка с подсказкой, как его настроить. */
  private static requireEncryptionProvider(): YdbEncryptionProvider {
    const provider = this.getEncryptionProvider();
    if (!provider) {
      throw new Error(
        `Encryption provider is not configured for entity ${this.name} ` +
          `but it has @YdbEncrypted fields. Pass "encryptionProvider" ` +
          `in YdbCoreModule.forRootAsync() options or configureEntities().`,
      );
    }
    return provider;
  }

  /** Blind index provider или понятная ошибка с подсказкой, как его настроить. */
  private static requireBlindIndexProvider(): YdbBlindIndexProvider {
    const provider = this.getBlindIndexProvider();
    if (!provider) {
      throw new Error(
        `Blind index provider is not configured for entity ${this.name} ` +
          `but it has @YdbEncrypted({ blindIndex: true }) fields. ` +
          `Pass "blindIndexProvider" in YdbCoreModule.forRootAsync() options ` +
          `or configureEntities().`,
      );
    }
    return provider;
  }

  /** Список известных полей сущности для сообщений об ошибках. */
  private static knownFields(meta: YdbEntityMetadata): string {
    return Object.keys(meta.schema).join(', ');
  }

  /**
   * Fail-fast проверка колонок select: опечатка иначе уйдёт в YDB
   * и вернётся непонятной SQL-ошибкой.
   */
  private static validateSelectFields(
    select: string[] | undefined,
    meta: YdbEntityMetadata,
  ): void {
    if (!select?.length) return;
    for (const field of select) {
      if (!meta.schema[field]) {
        throw new Error(
          `Unknown field in select: "${field}" on entity ${this.name}. ` +
            `Known fields: ${this.knownFields(meta)}. ` +
            `Check for a typo in the property name.`,
        );
      }
    }
  }

  protected static getCreateDateColumn(): string | undefined {
    return Reflect.getMetadata(YDB_CREATE_DATE_KEY, this) as string | undefined;
  }

  protected static getUpdateDateColumn(): string | undefined {
    return Reflect.getMetadata(YDB_UPDATE_DATE_KEY, this) as string | undefined;
  }

  protected static getExecutor(trx?: YdbExecutor): YdbExecutor {
    const db = trx ?? getEntityRuntime(this).executor;
    if (!db) {
      throw new Error(
        `YDB executor not set for entity ${this.name}. ` +
          `Register the entity via YdbModule.forFeature([${this.name}]) (NestJS) ` +
          `or pass it to configureEntities([${this.name}], { executor }) (standalone).`,
      );
    }
    return db;
  }

  /** Генератор UUID для PK: из рантайма (uuidVersion в опциях модуля), по умолчанию v7. */
  protected static generateUuid(): string {
    return getEntityRuntime(this).uuidGenerator?.() ?? uuidv7();
  }

  protected static getMeta(this: typeof YdbBaseEntity) {
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

  /**
   * Конвертирует enum значение для записи в БД: string → index (Int32) или string → string (Utf8).
   * Бросает ошибку при невалидном значении.
   */
  private static convertEnumOut(
    value: any,
    enumMeta: YdbEnumMeta | undefined,
  ): any {
    if (!enumMeta || value === null || value === undefined) return value;
    const str = String(value);
    if (!enumMeta.values.includes(str)) {
      throw new Error(
        `Invalid enum value "${value}" for field "${enumMeta.propertyKey}". Allowed: ${enumMeta.values.join(', ')}`,
      );
    }
    // Int32: строка → порядковый индекс; Utf8: строка как есть
    return enumMeta.storage === 'Int32' ? enumMeta.values.indexOf(str) : str;
  }

  /**
   * Конвертирует enum значение из БД: index (Int32) → string или string → string.
   */
  private static convertEnumIn(
    value: any,
    enumMeta: YdbEnumMeta | undefined,
  ): any {
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
      return value; // fallback
    }
    return value;
  }

  protected static bindParams(
    this: typeof YdbBaseEntity,
    query: any,
    data: Record<string, any>,
    keys: string[],
    dbSchema?: Record<string, YdbPrimitive>,
  ) {
    const { schema } = this.getMeta();
    const effectiveSchema = dbSchema ?? schema;
    const enums = getYdbEnumMetadata(this);
    for (const k of keys) {
      const type = effectiveSchema[k];
      let value = data[k];
      if (!type) throw new Error(`No schema for field: ${k}`);
      const enumMeta = enums.find((e) => e.propertyKey === k);
      value = this.convertEnumOut(value, enumMeta);
      query.parameter(k, mapToYdb(type, value));
    }
  }

  /**
   * Собирает AAD-строку из значений полей @YdbSecurityAAD()
   * в лексикографическом порядке полей.
   */
  protected static buildAAD(
    entity: Record<string, any>,
    aadFieldNames: string[],
  ): string {
    return aadFieldNames
      .filter((name) => entity[name] !== undefined && entity[name] !== null)
      .map((name) => `${name}=${entity[name]}`)
      .join(';');
  }

  /** Расширенная схема: entity поля + synthetic {field}_bi колонки. */
  protected static getDbSchema(
    meta: YdbEntityMetadata,
  ): Record<string, YdbPrimitive> {
    const schema: Record<string, YdbPrimitive> = { ...meta.schema };
    for (const ef of meta.encryptedFields) {
      if (ef.blindIndex) schema[`${ef.propertyKey}_bi`] = 'Utf8';
    }
    return schema;
  }

  /**
   * Возвращает копию сущности с зашифрованными полями и _bi колонками.
   * Исходный объект не мутируется: он должен хранить plaintext, иначе
   * повторный save() зашифрует ciphertext повторно.
   * Null/undefined не шифруются.
   */
  protected static async encryptEntity(
    entity: Record<string, any>,
    meta: YdbEntityMetadata,
  ): Promise<Record<string, any>> {
    if (!meta.encryptedFields.length) return entity;

    const encryptionProvider = this.requireEncryptionProvider();
    const pkField = meta.primaryKeys[0] ?? 'uuid';
    const pkValue = entity[pkField];

    const baseContext: YdbEncryptionContext = {
      entityName: this.name,
      tableName: meta.tableName,
      fieldName: '',
      primaryKeyValue:
        pkValue !== undefined && pkValue !== null ? String(pkValue) : undefined,
      aadFields: {},
    };

    const aadFields: Record<string, string> = {};
    for (const aadName of meta.aadFields) {
      const av = entity[aadName];
      if (av !== undefined && av !== null) aadFields[aadName] = String(av);
    }

    const encrypted = { ...entity };
    for (const ef of meta.encryptedFields) {
      const value = entity[ef.propertyKey];
      if (value === null || value === undefined) continue;

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

  /** Дешифрует поля в результате запроса. Null/undefined пропускаются. */
  protected static async decryptResult(
    result: Record<string, any> | Record<string, any>[] | null,
    meta: YdbEntityMetadata,
  ): Promise<void> {
    if (!result) return;
    const rows: Record<string, any>[] = Array.isArray(result)
      ? result
      : [result];

    const encryptionProvider = this.getEncryptionProvider();
    if (!encryptionProvider) return;

    const pkField = meta.primaryKeys[0] ?? 'uuid';

    for (const row of rows) {
      const aadFields: Record<string, string> = {};
      for (const aadName of meta.aadFields) {
        const av = row[aadName];
        if (av !== undefined && av !== null) aadFields[aadName] = String(av);
      }

      for (const ef of meta.encryptedFields) {
        const ct = row[ef.propertyKey];
        if (ct === null || ct === undefined) continue;

        const aad = ef.aadOverride ?? this.buildAAD(row, meta.aadFields);
        row[ef.propertyKey] = await encryptionProvider.decrypt(
          ct as Uint8Array,
          aad,
          {
            entityName: this.name,
            tableName: meta.tableName,
            fieldName: ef.propertyKey,
            primaryKeyValue:
              row[pkField] !== undefined && row[pkField] !== null
                ? String(row[pkField])
                : undefined,
            aadFields,
          },
        );
      }
    }
  }

  /**
   * Преобразует WHERE: зашифрованные поля → {field}_bi колонки через blind index hash.
   */
  protected static async processWhere(
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
          `Cannot search by encrypted field "${k}" on entity ${this.name}: ` +
            `blind index is disabled for it. ` +
            `Use @YdbEncrypted({ blindIndex: true }) to make it searchable.`,
        );
      }
      if (!blindIndexProvider) {
        throw new Error(
          `Blind index provider is not configured for entity ${this.name} ` +
            `but it has @YdbEncrypted({ blindIndex: true }) fields. ` +
            `Pass "blindIndexProvider" in YdbCoreModule.forRootAsync() options ` +
            `or configureEntities().`,
        );
      }
      const value = where[k];
      if (value === undefined) continue;
      processedWhere[`${k}_bi`] = await blindIndexProvider.hash(String(value), {
        entityName: this.name,
        tableName: meta.tableName,
        fieldName: k,
        primaryKeyValue: undefined,
        aadFields: {},
      });
    }

    return { processedWhere, dbSchema: this.getDbSchema(meta) };
  }

  /**
   * Общий конвейер WHERE для find/findAll/count:
   * blind index → фильтрация undefined → валидация полей → WHERE-клауза.
   */
  private static async buildWhere(
    this: typeof YdbBaseEntity,
    where: Record<string, any>,
    meta: YdbEntityMetadata,
  ): Promise<{
    whereClause: string;
    values: Record<string, any>;
    keys: string[];
    dbSchema: Record<string, YdbPrimitive>;
  }> {
    const { processedWhere, dbSchema } = await this.processWhere(where, meta);
    const keys = Object.keys(processedWhere).filter(
      (k) => processedWhere[k] !== undefined,
    );
    for (const k of keys) {
      if (!dbSchema[k]) {
        throw new Error(
          `Unknown field in WHERE: "${k}" on entity ${this.name}. ` +
            `Known fields: ${this.knownFields(meta)}. ` +
            `Check for a typo in the property name.`,
        );
      }
    }
    const conditions = keys
      .map((k) => `${quoteIdentifier(k)} = $${k}`)
      .join(' AND ');
    return {
      whereClause: keys.length ? `WHERE ${conditions}` : '',
      values: processedWhere,
      keys,
      dbSchema,
    };
  }

  protected static async executeQuery<T>(
    query: YdbQuery,
    options?: QueryOptions,
  ): Promise<T> {
    const { signal, timeout } = options ?? {};

    if (signal) {
      if (signal.aborted) throw new Error('Query aborted by signal');
      query.signal(signal);
    }

    if (timeout && timeout > 0) {
      query.timeout(timeout);
    }

    return (await query) as T;
  }

  private static resolveLimit(limit?: number): number {
    const value = Number.isFinite(limit) ? Math.floor(limit as number) : 100;
    return Math.max(1, Math.min(value, 1000));
  }

  private static resolveOffset(offset?: number): number {
    const value = Number.isFinite(offset) ? Math.floor(offset as number) : 0;
    return Math.max(0, value);
  }

  /**
   * Создаёт инстанс сущности из строки БД.
   * Synthetic {field}_bi колонки (blind index) в инстанс не попадают.
   */
  protected static instantiate(
    this: typeof YdbBaseEntity,
    row: Record<string, any>,
  ): YdbBaseEntity {
    const meta = this.getMeta();
    const Ctor = this as new () => YdbBaseEntity;
    const instance = new Ctor();
    const enums = getYdbEnumMetadata(this);
    for (const [key, value] of Object.entries(row)) {
      if (isSyntheticColumn(meta, key)) continue;
      const enumMeta = enums.find((e) => e.propertyKey === key);
      (instance as any)[key] = this.convertEnumIn(value, enumMeta);
    }
    return instance;
  }

  /**
   * Загружает сущности Target одним запросом `WHERE column IN (...)`.
   * Строки дешифруются и инстанцируются через методы Target.
   */
  private static async fetchByColumnIn(
    Target: typeof YdbBaseEntity,
    column: string,
    values: any[],
    options?: QueryOptions,
  ): Promise<YdbBaseEntity[]> {
    const targetMeta = getYdbEntityMetadata(Target);
    if (!targetMeta) {
      throw new Error(
        `Target entity ${Target.name} is not decorated with @YdbEntity`,
      );
    }
    const columnType = targetMeta.schema[column];
    if (!columnType) {
      throw new Error(
        `No schema for join column "${column}" on entity ${Target.name}`,
      );
    }

    const exec = this.getExecutor(options?.trx);
    const inParams = values.map((_, i) => `$p${i}`).join(', ');
    const sql = `SELECT * FROM ${quoteIdentifier(targetMeta.tableName)} WHERE ${quoteIdentifier(column)} IN (${inParams})`;

    const query = exec([sql] as unknown as TemplateStringsArray);
    values.forEach((value, i) => {
      query.parameter(`p${i}`, mapToYdb(columnType, value));
    });

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    const raw = rows[0] ?? [];

    await Target.decryptResult(raw, targetMeta);
    return raw.map((r) => Target.instantiate(r));
  }

  /**
   * Batch-загрузка many-to-many: join-таблица + инверсные сущности.
   * Возвращает Map<owner PK, related entities[]>.
   */
  private static async loadManyToManyRelation(
    items: YdbBaseEntity[],
    Target: typeof YdbBaseEntity,
    joinTable: ResolvedJoinTable,
    ownerPks: any[],
    options?: QueryOptions,
  ): Promise<Map<any, YdbBaseEntity[]>> {
    const exec = this.getExecutor(options?.trx);
    const inParams = ownerPks.map((_, i) => `$p${i}`).join(', ');
    const sql =
      `SELECT ${quoteIdentifier(joinTable.ownerColumn)}, ` +
      `${quoteIdentifier(joinTable.inverseColumn)} ` +
      `FROM ${quoteIdentifier(joinTable.tableName)} ` +
      `WHERE ${quoteIdentifier(joinTable.ownerColumn)} IN (${inParams})`;

    const joinQuery = exec([sql] as unknown as TemplateStringsArray);
    ownerPks.forEach((value, i) => {
      joinQuery.parameter(`p${i}`, mapToYdb('Uuid', value));
    });

    const joinRows = await this.executeQuery<Record<string, any>[][]>(
      joinQuery,
      options,
    );
    const links = (joinRows[0] ?? []) as {
      [key: string]: any;
    }[];

    const inverseFks = links
      .map((row) => row[joinTable.inverseColumn])
      .filter((v) => v !== undefined);

    const targetPkField = getPrimaryKey(Target);
    const relatedEntities = await this.fetchByColumnIn(
      Target,
      targetPkField,
      inverseFks,
      options,
    );

    const byInversePk = new Map<any, YdbBaseEntity>();
    for (const entity of relatedEntities) {
      byInversePk.set((entity as any)[targetPkField], entity);
    }

    const result = new Map<any, YdbBaseEntity[]>();
    for (const row of links) {
      const ownerFk = row[joinTable.ownerColumn];
      const inverseFk = row[joinTable.inverseColumn];
      const entity = byInversePk.get(inverseFk);
      if (!entity) continue;
      const group = result.get(ownerFk);
      if (group) {
        group.push(entity);
      } else {
        result.set(ownerFk, [entity]);
      }
    }

    return result;
  }

  /**
   * Batch eager loading: один запрос IN (...) на relation вместо N+1.
   */
  private static async loadEagerRelations<T extends YdbBaseEntity>(
    items: T[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!items.length) return;

    const constructor = items[0].constructor as typeof YdbBaseEntity;
    const eager = getEagerRelations(constructor);
    if (!eager.length) return;

    const allRelations = getYdbRelationsMetadata(constructor);
    const pkField = getPrimaryKey(constructor);

    for (const name of eager) {
      const rel = allRelations.find((r) => r.propertyKey === name);
      if (!rel) continue;

      const Target = rel.target();

      if (rel.type === 'one-to-many') {
        const joinColumnName = resolveJoinColumn(rel.joinColumn!);
        const pks = items
          .map((item) => (item as any)[pkField])
          .filter((v) => v !== undefined);
        if (!pks.length) continue;

        const children = await this.fetchByColumnIn(
          Target,
          joinColumnName,
          pks,
          options,
        );

        const byFk = new Map<any, YdbBaseEntity[]>();
        for (const child of children) {
          const fk = (child as any)[joinColumnName];
          const group = byFk.get(fk);
          if (group) {
            group.push(child);
          } else {
            byFk.set(fk, [child]);
          }
        }

        for (const item of items) {
          (item as any)[name] = byFk.get((item as any)[pkField]) ?? [];
        }
      } else if (rel.type === 'many-to-many') {
        const joinTable = resolveManyToManyJoinTable(constructor, rel);
        if (!joinTable) continue;

        const pks = items
          .map((item) => (item as any)[pkField])
          .filter((v) => v !== undefined);
        if (!pks.length) continue;

        const related = await this.loadManyToManyRelation(
          items,
          Target,
          joinTable,
          pks,
          options,
        );

        for (const item of items) {
          (item as any)[name] = related.get((item as any)[pkField]) ?? [];
        }
      } else {
        // many-to-one / one-to-one
        const joinColumnName = resolveJoinColumn(rel.joinColumn!);
        const fks = items
          .map((item) => (item as any)[joinColumnName])
          .filter((v) => v !== undefined);
        if (!fks.length) continue;

        const targetPkField = getPrimaryKey(Target);
        const parents = await this.fetchByColumnIn(
          Target,
          targetPkField,
          fks,
          options,
        );

        const byPk = new Map<any, YdbBaseEntity>();
        for (const parent of parents) {
          byPk.set((parent as any)[targetPkField], parent);
        }

        for (const item of items) {
          (item as any)[name] = byPk.get((item as any)[joinColumnName]) ?? null;
        }
      }
    }
  }

  static async find<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    this.validateSelectFields(options?.select, meta);

    const { whereClause, values, keys, dbSchema } = await this.buildWhere(
      where,
      meta,
    );
    if (!keys.length) {
      throw new Error(
        `find() on ${this.name} requires at least one condition. ` +
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

    await this.decryptResult(raw, meta);

    const result = this.instantiate(raw) as T;

    await this.loadEagerRelations([result], options);

    await this.callHooks('afterFind', result);

    return result;
  }

  static async findAll<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any> = {},
    options?: QueryOptions,
  ): Promise<T[]> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    this.validateSelectFields(options?.select, meta);

    const { whereClause, values, keys, dbSchema } = await this.buildWhere(
      where,
      meta,
    );
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

    await this.decryptResult(raw, meta);

    const result = raw.map((r) => this.instantiate(r) as T);

    if (result.length) {
      await this.loadEagerRelations(result, options);
    }

    return result;
  }

  static async count(
    this: typeof YdbBaseEntity,
    where: Record<string, any> = {},
    options?: QueryOptions,
  ): Promise<number> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();

    const { whereClause, values, keys, dbSchema } = await this.buildWhere(
      where,
      meta,
    );
    const sql = `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(meta.tableName)} ${whereClause}`;

    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    return Number(rows[0]?.[0]?.cnt ?? 0);
  }

  /**
   * Находит первую сущность по WHERE-условию.
   * Алиас для find() — тот же signature, более явный интент.
   */
  static async findOneBy<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return this.find<T>(where, options);
  }

  /**
   * Находит все сущности по WHERE-условию.
   * Алиас для findAll() — тот же signature, более явный интент.
   */
  static async findBy<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.findAll<T>(where, options);
  }

  /**
   * Цепочный query builder: Entity.query().where(...).orderBy(...).getMany().
   */
  static query<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
  ): YdbQueryBuilder<T> {
    return new YdbQueryBuilder<T>(this);
  }

  /**
   * @internal Мост для YdbQueryBuilder: собрать WHERE по метаданным сущности.
   * Не является частью публичного API.
   */
  static _buildWhereClause(
    this: typeof YdbBaseEntity,
    where: Record<string, any>,
  ) {
    return this.buildWhere(where, this.getMeta());
  }

  /**
   * @internal Мост для YdbQueryBuilder: выполнить SELECT и вернуть сущности
   * (дешифровка + инстанцирование + eager relations).
   */
  static async _executeSelect<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
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

    const meta = this.getMeta();
    await this.decryptResult(raw, meta);

    const result = raw.map((r) => this.instantiate(r) as T);
    if (result.length) {
      await this.loadEagerRelations(result, options);
    }
    return result;
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
    const exec = this.getExecutor(options?.trx);
    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    return Number(rows[0]?.[0]?.cnt ?? 0);
  }

  /**
   * Сохраняет сущность:
   *  - без `uuid` — вставка (uuid присваивается автоматически);
   *  - с `uuid` — UPDATE, если строки нет — ошибка.
   */
  static async save<T extends YdbBaseEntity & { uuid?: string }>(
    this: { new (): T } & typeof YdbBaseEntity,
    entity: T,
    options?: QueryOptions,
  ): Promise<T> {
    if (entity.uuid) {
      return this.update(
        entity as YdbBaseEntity & { uuid: string },
        options,
      ) as Promise<T>;
    }
    return this.insert(entity, options) as Promise<T>;
  }

  /**
   * Удаляет сущность по pk.
   * Возвращает удалённую запись (RETURNING *) или null, если не найдена.
   * Если у сущности есть хуки @BeforeRemove, запись сначала загружается
   * (SELECT) и хуки вызываются на инстансе до удаления.
   */
  static async delete<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    pkValue: string | number,
    options?: QueryOptions,
  ): Promise<T | null> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const dbSchema = this.getDbSchema(meta);
    const pkField = meta.primaryKeys[0] ?? 'uuid';
    if (!dbSchema[pkField]) {
      throw new Error(
        `Cannot delete ${this.name} by primary key: column "${pkField}" ` +
          `is not declared. Declare it via @YdbPrimaryColumn ` +
          `(or a "uuid" @YdbColumn).`,
      );
    }
    const pkType = dbSchema[pkField];

    // beforeRemove-хуки работают на инстансе — загружаем запись до удаления
    if (getLifecycleHooks(this).beforeRemove.length) {
      const entity = await this.find<T>({ [pkField]: pkValue }, options);
      if (!entity) return null;
      await this.callHooks('beforeRemove', entity);
    }

    const sql = `DELETE FROM ${quoteIdentifier(meta.tableName)} WHERE ${quoteIdentifier(pkField)} = $pk RETURNING *`;
    const query = exec([sql] as unknown as TemplateStringsArray);
    query.parameter('pk', mapToYdb(pkType, pkValue));

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    const raw = rows[0]?.[0] ?? null;
    if (!raw) return null;

    await this.decryptResult(raw, meta);
    return this.instantiate(raw) as T;
  }

  static async insertMany<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    entities: T[],
    options?: QueryOptions,
  ): Promise<T[]> {
    if (!entities.length) return [];

    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const { tableName } = meta;
    const dbSchema = this.getDbSchema(meta);

    for (const e of entities) {
      if (!(e as any).uuid) (e as any).uuid = this.generateUuid();
    }

    // Автоматическая простановка Timestamp колонок
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

    const provider = this.getValidationProvider();
    if (provider) {
      for (const e of entities) {
        const errors = await provider.validate(e);
        if (errors.length) {
          throw new Error(
            `Validation failed for ${this.name}: ${errors.join('; ')}`,
          );
        }
      }
    }

    const dataList = await Promise.all(
      entities.map((e) =>
        this.encryptEntity({ ...(e as Record<string, any>) }, meta),
      ),
    );

    const keys = Object.keys(dbSchema);
    const columns = keys.map(quoteIdentifier).join(', ');
    const BATCH_SIZE = 100;

    for (let start = 0; start < entities.length; start += BATCH_SIZE) {
      const batch = dataList.slice(start, start + BATCH_SIZE);
      const valueRows: string[] = [];

      for (let i = 0; i < batch.length; i++) {
        const rowParams = keys.map((k) => `$${k}_${i}`).join(', ');
        valueRows.push(`(${rowParams})`);
      }

      const sql = `UPSERT INTO ${quoteIdentifier(tableName)} (${columns}) VALUES ${valueRows.join(', ')}`;

      const query = exec([sql] as unknown as TemplateStringsArray);

      for (let i = 0; i < batch.length; i++) {
        for (const k of keys) {
          query.parameter(
            `${k}_${i}`,
            mapToYdb(dbSchema[k], batch[i][k] ?? null),
          );
        }
      }

      await this.executeQuery(query, options);
    }

    return entities;
  }

  protected static async insert(
    this: typeof YdbBaseEntity,
    entity: YdbBaseEntity,
    options?: QueryOptions,
  ): Promise<YdbBaseEntity> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const { tableName, schema } = meta;
    const dbSchema = this.getDbSchema(meta);

    if (schema['uuid'] && !(entity as any).uuid) {
      (entity as any).uuid = this.generateUuid();
    }

    // Автоматическая простановка Timestamp колонок
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

    const data = await this.encryptEntity(
      { ...(entity as Record<string, any>) },
      meta,
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

  protected static async update(
    this: typeof YdbBaseEntity,
    entity: YdbBaseEntity & { uuid: string },
    options?: QueryOptions,
  ): Promise<YdbBaseEntity> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const { tableName } = meta;
    const dbSchema = this.getDbSchema(meta);

    // Автоматическая простановка Timestamp колонки обновления
    const updateDateCol = this.getUpdateDateColumn();
    if (updateDateCol) {
      (entity as any)[updateDateCol] = new Date();
    }

    await this.callHooks('beforeUpdate', entity);

    await this.runValidation(entity as Record<string, any>);

    const data = await this.encryptEntity(
      { ...(entity as Record<string, any>) },
      meta,
    );
    const keys = Object.keys(data).filter(
      (k) => k !== 'uuid' && data[k] !== undefined && dbSchema[k],
    );
    const setClause = keys
      .map((k) => `${quoteIdentifier(k)} = $${k}`)
      .join(', ');

    const sql = `
      UPDATE ${quoteIdentifier(tableName)}
      SET ${setClause}
      WHERE ${quoteIdentifier('uuid')} = $uuid
      RETURNING *
    `;
    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, data, [...keys, 'uuid'], dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    const raw = rows[0]?.[0] ?? null;
    if (!raw) {
      throw new Error(
        `Entity ${this.name} with uuid ${entity.uuid} not found — nothing to update`,
      );
    }
    await this.decryptResult(raw, meta);
    return this.instantiate(raw);
  }

  /**
   * Массовое обновление по условию.
   * Возвращает количество затронутых строк.
   * Lifecycle-хуки (beforeUpdate и т.п.) не срабатывают — инстансы не загружаются.
   */
  static async updateBy(
    this: typeof YdbBaseEntity,
    where: Record<string, any>,
    patch: Partial<Record<string, any>>,
    options?: QueryOptions,
  ): Promise<number> {
    if (!Object.keys(where).length) {
      throw new Error(
        `updateBy() on ${this.name} requires at least one WHERE condition to prevent full-table update`,
      );
    }
    if (!Object.keys(patch).length) {
      throw new Error(
        `updateBy() on ${this.name} requires at least one field in patch`,
      );
    }

    // Одно и то же поле в where и в patch приведёт к смешиванию значений параметров
    const collision = Object.keys(patch).filter((k) =>
      Object.prototype.hasOwnProperty.call(where, k),
    );
    if (collision.length) {
      throw new Error(
        `updateBy() on ${this.name}: field(s) ${collision.map((k) => `"${k}"`).join(', ')} present in both where and patch`,
      );
    }

    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const { tableName } = meta;
    const dbSchema = this.getDbSchema(meta);

    // Автоматическая простановка Timestamp колонки обновления
    const updateDateCol = this.getUpdateDateColumn();
    const data = { ...patch };
    if (updateDateCol && data[updateDateCol] === undefined) {
      data[updateDateCol] = new Date();
    }

    // Шифрование зашифрованных полей в patch
    const encryptedFieldsToProcess = meta.encryptedFields.filter((ef) =>
      Object.prototype.hasOwnProperty.call(data, ef.propertyKey),
    );
    if (encryptedFieldsToProcess.length) {
      const encryptionProvider = this.requireEncryptionProvider();
      for (const ef of encryptedFieldsToProcess) {
        const value = data[ef.propertyKey];
        if (value === null || value === undefined) continue;

        // AAD строится из полей строки, которых у нас нет: дешифровка после
        // такого update упадёт. Запрещаем, если нет явного aadOverride.
        if (!ef.aadOverride && meta.aadFields.length) {
          throw new Error(
            `updateBy() on ${this.name} cannot update encrypted field "${ef.propertyKey}": ` +
              `entity has @YdbSecurityAAD fields and no aadOverride is set — ` +
              `AAD cannot be reconstructed without the full row`,
          );
        }
        const aad = ef.aadOverride ?? this.buildAAD({}, meta.aadFields);
        const context: YdbEncryptionContext = {
          entityName: this.name,
          tableName: meta.tableName,
          fieldName: ef.propertyKey,
          primaryKeyValue: undefined,
          aadFields: {},
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

    // Валидация: все ключи patch должны быть в схеме
    const setKeys = Object.keys(data).filter((k) => dbSchema[k]);
    for (const k of Object.keys(data)) {
      if (!dbSchema[k]) {
        throw new Error(
          `Unknown field in patch: "${k}" on entity ${this.name}. ` +
            `Known fields: ${this.knownFields(meta)}. ` +
            `Check for a typo in the property name.`,
        );
      }
    }
    if (!setKeys.length) {
      throw new Error(`updateBy() on ${this.name}: no valid fields in patch`);
    }

    const setClause = setKeys
      .map((k) => `${quoteIdentifier(k)} = $${k}`)
      .join(', ');

    const {
      whereClause,
      values: whereValues,
      keys: whereKeys,
      dbSchema: whereDbSchema,
    } = await this.buildWhere(where, meta);
    if (!whereKeys.length) {
      throw new Error(
        `updateBy() on ${this.name} has no effective WHERE condition ` +
          `(all values are undefined) — refusing full-table update`,
      );
    }

    const allValues: Record<string, any> = { ...whereValues };
    for (const k of setKeys) {
      allValues[k] = data[k];
    }
    const allKeys = [...whereKeys, ...setKeys];
    const allDbSchema = { ...whereDbSchema, ...dbSchema };

    // RETURNING по PK: без него YDB не отдаёт result set и счётчик строк всегда 0
    const pkColumn = quoteIdentifier(meta.primaryKeys[0] ?? 'uuid');
    const sql = `UPDATE ${quoteIdentifier(tableName)} SET ${setClause} ${whereClause} RETURNING ${pkColumn}`;
    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, allValues, allKeys, allDbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    return rows[0]?.length ?? 0;
  }

  /**
   * Массовое удаление по условию.
   * Возвращает количество удалённых строк.
   * Lifecycle-хуки (beforeRemove) не срабатывают — инстансы не загружаются.
   */
  static async deleteBy(
    this: typeof YdbBaseEntity,
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<number> {
    if (!Object.keys(where).length) {
      throw new Error(
        `deleteBy() on ${this.name} requires at least one WHERE condition to prevent full-table delete`,
      );
    }

    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();

    const { whereClause, values, keys, dbSchema } = await this.buildWhere(
      where,
      meta,
    );
    if (!keys.length) {
      throw new Error(
        `deleteBy() on ${this.name} has no effective WHERE condition ` +
          `(all values are undefined) — refusing full-table delete`,
      );
    }

    // RETURNING по PK: без него YDB не отдаёт result set и счётчик строк всегда 0
    const pkColumn = quoteIdentifier(meta.primaryKeys[0] ?? 'uuid');
    const sql = `DELETE FROM ${quoteIdentifier(meta.tableName)} ${whereClause} RETURNING ${pkColumn}`;
    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );
    return rows[0]?.length ?? 0;
  }

  /**
   * Сериализация в JSON: исключает synthetic {field}_bi колонки
   * (blind index) и внутренние служебные поля.
   * Возвращает расшифрованные значения — те, что хранятся в инстансе.
   */
  toJSON(): Record<string, any> {
    const meta = getYdbEntityMetadata(this.constructor as typeof YdbBaseEntity);
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(this)) {
      if (meta && isSyntheticColumn(meta, key)) continue;
      // BigInt не поддерживается JSON.stringify — сериализуем строкой
      result[key] = typeof value === 'bigint' ? String(value) : value;
    }
    return result;
  }

  async loadRelations(
    relations: string[],
    options?: QueryOptions,
  ): Promise<this> {
    const constructor = this.constructor as typeof YdbBaseEntity;
    const allRelations = getYdbRelationsMetadata(constructor);

    for (const name of relations) {
      const rel = allRelations.find((r) => r.propertyKey === name);
      if (!rel) {
        const known = allRelations.map((r) => r.propertyKey).join(', ');
        throw new Error(
          `Unknown relation: "${name}" on entity ${constructor.name}. ` +
            `Known relations: ${known || '(none)'}. ` +
            `Check the property name or declare the relation ` +
            `via @OneToMany/@ManyToOne/@OneToOne.`,
        );
      }

      const Target = rel.target();

      if (rel.type === 'one-to-many') {
        const joinColumnName = resolveJoinColumn(rel.joinColumn!);
        const pkField = getPrimaryKey(constructor);
        const pkValue = (this as any)[pkField];
        if (pkValue === undefined) {
          throw new Error(
            `Cannot load one-to-many relation "${name}": ` +
              `primary key "${pkField}" is undefined on ${constructor.name}`,
          );
        }
        (this as any)[name] = await Target.findAll(
          { [joinColumnName]: pkValue },
          options,
        );
      } else if (rel.type === 'many-to-many') {
        const pkField = getPrimaryKey(constructor);
        const pkValue = (this as any)[pkField];
        if (pkValue === undefined) {
          throw new Error(
            `Cannot load many-to-many relation "${name}": ` +
              `primary key "${pkField}" is undefined on ${constructor.name}`,
          );
        }
        const joinTable = resolveManyToManyJoinTable(constructor, rel);
        if (!joinTable) {
          throw new Error(
            `Cannot load many-to-many relation "${name}": ` +
              `join table is not defined on ${constructor.name}. ` +
              `Mark the owning side with @JoinTable.`,
          );
        }
        const related = await (
          this.constructor as typeof YdbBaseEntity
        ).loadManyToManyRelation([this], Target, joinTable, [pkValue], options);
        (this as any)[name] = related.get(pkValue) ?? [];
      } else if (rel.type === 'many-to-one' || rel.type === 'one-to-one') {
        const joinColumnName = resolveJoinColumn(rel.joinColumn!);
        const fkValue = (this as any)[joinColumnName];
        if (fkValue === undefined) {
          throw new Error(
            `Cannot load relation "${name}": ` +
              `join column "${joinColumnName}" is undefined on ${constructor.name}`,
          );
        }
        const targetPk = getPrimaryKey(Target);
        (this as any)[name] = await Target.find(
          { [targetPk]: fkValue },
          options,
        );
      }
    }

    return this;
  }
}

/** Извлекает имя свойства из стрелочной функции вида (x) => x.field */
function resolveJoinColumn(
  joinColumn: string | ((target: any) => any),
): string {
  if (typeof joinColumn === 'string') return joinColumn;

  const proxy = new Proxy(
    {},
    {
      get: (_, prop) => prop as string,
    },
  );
  return joinColumn(proxy);
}

/** Возвращает первый PK из метаданных или fallback на 'uuid' */
function getPrimaryKey(target: typeof YdbBaseEntity): string {
  const meta = getYdbEntityMetadata(target);
  if (meta?.primaryKeys?.length) return meta.primaryKeys[0];
  return 'uuid';
}

/**
 * Находит метаданные join-таблицы для many-to-many,
 * ориентированные относительно запрашиваемой сущности (owner).
 */
interface ResolvedJoinTable {
  tableName: string;
  ownerColumn: string;
  inverseColumn: string;
  ownerEntity: typeof YdbBaseEntity;
  inverseEntity: typeof YdbBaseEntity;
}

function resolveManyToManyJoinTable(
  owner: typeof YdbBaseEntity,
  relation: { propertyKey: string; target: () => typeof YdbBaseEntity },
): ResolvedJoinTable | undefined {
  const ownerMeta = getYdbEntityMetadata(owner);
  const inverseEntity = relation.target();
  const inverseMeta = getYdbEntityMetadata(inverseEntity);
  if (!ownerMeta || !inverseMeta) return undefined;

  const ownJoinTables = getYdbJoinTableMetadata(owner);
  const own = ownJoinTables.find(
    (jt) => jt.propertyKey === relation.propertyKey,
  );

  if (own) {
    return {
      tableName: own.tableName,
      ownerColumn: own.joinColumn ?? `${ownerMeta.tableName}_uuid`,
      inverseColumn: own.inverseJoinColumn ?? `${inverseMeta.tableName}_uuid`,
      ownerEntity: owner,
      inverseEntity,
    };
  }

  // Пробуем найти владеющую сторону на inverse-сущности
  const inverseRelations = getYdbRelationsMetadata(inverseEntity).filter(
    (r) => r.type === 'many-to-many' && r.target() === owner,
  );
  for (const invRel of inverseRelations) {
    const invJoinTables = getYdbJoinTableMetadata(inverseEntity);
    const inv = invJoinTables.find(
      (jt) => jt.propertyKey === invRel.propertyKey,
    );
    if (inv) {
      return {
        tableName: inv.tableName,
        ownerColumn: inv.inverseJoinColumn ?? `${ownerMeta.tableName}_uuid`,
        inverseColumn: inv.joinColumn ?? `${inverseMeta.tableName}_uuid`,
        ownerEntity: owner,
        inverseEntity,
      };
    }
  }

  return undefined;
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
