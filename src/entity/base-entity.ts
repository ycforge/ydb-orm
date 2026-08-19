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
        `YDB executor not set for entity ${this.name}. Did you forget to import it via YdbModule.forFeature()?`,
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
      throw new Error(`Entity ${this.name} is not decorated with @YdbEntity`);
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
   * PK-поля сущности: из метаданных (поддерживается составной PK),
   * fallback — одиночный 'uuid'.
   */
  protected static getPkFields(meta: YdbEntityMetadata): string[] {
    return meta.primaryKeys.length ? meta.primaryKeys : ['uuid'];
  }

  /**
   * Проверяет, что все компоненты PK заданы в объекте, и возвращает
   * фильтр { pkField: value }. Бросает понятную ошибку, если какой-то
   * компонент отсутствует (undefined/null).
   */
  protected static requirePkValues(
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
        `Cannot ${action} ${this.name}: primary key field(s) ${missing
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
  protected static pkValueForContext(
    meta: YdbEntityMetadata,
    source: Record<string, any>,
  ): string | undefined {
    const parts = this.getPkFields(meta)
      .map((f) => source[f])
      .filter((v) => v !== undefined && v !== null);
    return parts.length ? parts.map(String).join(':') : undefined;
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

    const encryptionProvider = this.getEncryptionProvider();
    if (!encryptionProvider) {
      throw new Error(
        `Encryption provider is not configured for entity ${this.name} but @YdbEncrypted fields exist`,
      );
    }
    const blindIndexProvider = this.getBlindIndexProvider();

    const baseContext: YdbEncryptionContext = {
      entityName: this.name,
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
        if (!blindIndexProvider) {
          throw new Error(
            `Blind index provider is not configured for entity ${this.name}`,
          );
        }
        encrypted[`${ef.propertyKey}_bi`] = await blindIndexProvider.hash(
          String(value),
          { ...baseContext, fieldName: ef.propertyKey },
        );
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
          `Cannot search by encrypted field "${k}" without blind index`,
        );
      }
      if (!blindIndexProvider) {
        throw new Error(
          `Blind index provider is not configured for entity ${this.name}`,
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
      if (!dbSchema[k]) throw new Error(`Unknown field in WHERE: ${k}`);
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
    // Тип owner PK — из схемы owner-сущности (составной PK в m2m не поддерживается,
    // используется первый PK-компонент как FK-колонка join-таблицы)
    const ownerPkField = getPrimaryKey(joinTable.ownerEntity);
    const ownerPkType =
      getYdbEntityMetadata(joinTable.ownerEntity)?.schema[ownerPkField] ??
      'Uuid';
    const sql =
      `SELECT ${quoteIdentifier(joinTable.ownerColumn)}, ` +
      `${quoteIdentifier(joinTable.inverseColumn)} ` +
      `FROM ${quoteIdentifier(joinTable.tableName)} ` +
      `WHERE ${quoteIdentifier(joinTable.ownerColumn)} IN (${inParams})`;

    const joinQuery = exec([sql] as unknown as TemplateStringsArray);
    ownerPks.forEach((value, i) => {
      joinQuery.parameter(`p${i}`, mapToYdb(ownerPkType, value));
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
   *  - без заполненного PK — вставка (uuid генерируется автоматически,
   *    если у сущности есть колонка `uuid`);
   *  - с заполненным PK (все компоненты при составном PK) — UPDATE,
   *    если строки нет — ошибка.
   */
  static async save<T extends YdbBaseEntity & { uuid?: string }>(
    this: { new (): T } & typeof YdbBaseEntity,
    entity: T,
    options?: QueryOptions,
  ): Promise<T> {
    const meta = this.getMeta();
    const pkFields = this.getPkFields(meta);
    const hasPk = pkFields.every(
      (f) =>
        (entity as Record<string, any>)[f] !== undefined &&
        (entity as Record<string, any>)[f] !== null,
    );
    if (hasPk) {
      return this.update(entity, options) as Promise<T>;
    }
    return this.insert(entity, options) as Promise<T>;
  }

  /**
   * Удаляет сущность по PK.
   * Для одиночного PK принимает значение (string/number) или объект
   * `{ [pkField]: value }`; для составного PK — объект со всеми компонентами.
   * Возвращает удалённую запись (RETURNING *) или null, если не найдена.
   * Если у сущности есть хуки @BeforeRemove, запись сначала загружается
   * (SELECT) и хуки вызываются на инстансе до удаления.
   */
  static async delete<T extends YdbBaseEntity>(
    this: { new (): T } & typeof YdbBaseEntity,
    pkValue: string | number | Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const dbSchema = this.getDbSchema(meta);
    const pkFields = this.getPkFields(meta);
    const filter = this.requirePkValues(
      meta,
      typeof pkValue === 'object' && pkValue !== null
        ? pkValue
        : { [pkFields[0]]: pkValue },
      'delete',
    );

    // beforeRemove-хуки работают на инстансе — загружаем запись до удаления
    if (getLifecycleHooks(this).beforeRemove.length) {
      const entity = await this.find<T>(filter, options);
      if (!entity) return null;
      await this.callHooks('beforeRemove', entity);
    }

    // Для одиночного PK сохраняем историческое имя параметра $pk
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

    // uuid генерируется только если у сущности объявлена такая колонка;
    // для составного PK компоненты обязан заполнить вызывающий код
    if (meta.schema['uuid']) {
      for (const e of entities) {
        if (!(e as any).uuid) (e as any).uuid = this.generateUuid();
      }
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

    for (const e of entities) {
      this.requirePkValues(meta, e as Record<string, any>, 'insert');
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

    // Батчи по 100. Внутри батча сущности группируются по набору колонок:
    // опущенные поля (undefined) не включаются в INSERT, чтобы не затирать
    // YDB-дефолты NULL'ами и сохранять различие «поле опущено» vs «явный NULL».
    // Набор колонок считается ПОСЛЕ encryptEntity (шифрование/blind-index
    // могут добавить {field}_bi колонки). На каждый уникальный набор
    // колонок в батче — отдельный UPSERT.
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
            query.parameter(`${k}_${i}`, mapToYdb(dbSchema[k], row[k]));
          }
        });

        await this.executeQuery(query, options);
      }
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

    // Все компоненты PK обязаны быть заполнены (uuid — автогенерацией выше)
    this.requirePkValues(meta, entity as Record<string, any>, 'insert');

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
    entity: YdbBaseEntity,
    options?: QueryOptions,
  ): Promise<YdbBaseEntity> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const { tableName } = meta;
    const dbSchema = this.getDbSchema(meta);
    const pkFields = this.getPkFields(meta);

    // Автоматическая простановка Timestamp колонки обновления
    const updateDateCol = this.getUpdateDateColumn();
    if (updateDateCol) {
      (entity as any)[updateDateCol] = new Date();
    }

    await this.callHooks('beforeUpdate', entity);

    await this.runValidation(entity as Record<string, any>);

    // Проверяем наличие изменяемых полей ДО шифрования/генерации YQL:
    // иначе получим невалидный пустой SET (или не ту ошибку из encryptEntity)
    const rawKeys = Object.keys(entity).filter(
      (k) =>
        !pkFields.includes(k) &&
        (entity as Record<string, any>)[k] !== undefined &&
        dbSchema[k],
    );
    if (!rawKeys.length) {
      throw new Error(
        `Cannot update ${this.name}: no fields to update — ` +
          `entity contains only primary key and/or undefined values`,
      );
    }

    const data = await this.encryptEntity(
      { ...(entity as Record<string, any>) },
      meta,
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
        `Entity ${this.name} with ${pkDescription} not found — nothing to update`,
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
      const encryptionProvider = this.getEncryptionProvider();
      if (!encryptionProvider) {
        throw new Error(
          `Encryption provider is not configured for entity ${this.name} but @YdbEncrypted fields exist in patch`,
        );
      }
      const blindIndexProvider = this.getBlindIndexProvider();
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
          if (!blindIndexProvider) {
            throw new Error(
              `Blind index provider is not configured for entity ${this.name}`,
            );
          }
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
        throw new Error(`Unknown field in patch: ${k}`);
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

    const allValues: Record<string, any> = { ...whereValues };
    for (const k of setKeys) {
      allValues[k] = data[k];
    }
    const allKeys = [...whereKeys, ...setKeys];
    const allDbSchema = { ...whereDbSchema, ...dbSchema };

    // RETURNING по PK: без него YDB не отдаёт result set и счётчик строк всегда 0
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

    // RETURNING по PK: без него YDB не отдаёт result set и счётчик строк всегда 0
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
      if (!rel) throw new Error(`Unknown relation: ${name}`);

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
