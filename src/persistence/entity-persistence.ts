import type { YdbExecutor, YdbQuery } from '../core/interfaces.js';
import {
  getYdbEntityMetadata,
  type YdbEntityMetadata,
} from '../metadata/entity-metadata.js';
import { mapToYdb } from '../core/mapper.js';
import { v7 as uuidv7 } from 'uuid';
import type { QueryOptions } from '../core/query-options.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import { getEagerRelations } from '../decorators/eager.decorator.js';
import {
  BLIND_INDEX_SUFFIX,
  blindIndexColumnName,
} from '../decorators/encryption.decorator.js';
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
import { resolveOperationExecutor } from '../transaction/transaction-context.js';
import {
  chunkInValues,
  dedupeInValues,
  resolveRetrieveLimit,
  resolveRetrieveOffset,
} from '../core/query-limits.js';
import { executeYdbQuery } from '../core/execute-query.js';
import type { YdbPrimitive } from '../core/types.js';
import {
  getYdbEnumMetadata,
  type YdbEnumMeta,
} from '../decorators/enum.decorator.js';
import type { YdbValidationProvider } from '../validation/ydb-validate.interface.js';
import { YdbEntityValidationError } from '../validation/validation-error.js';
import { YdbQueryBuilder } from '../query/query-builder.js';
import type { YdbBaseEntity } from '../entity/base-entity.js';
import {
  getYdbRelationsMetadata,
  resolveRelationJoinColumn,
  type RelationMetadata,
} from '../decorators/relation.decorators.js';
import { resolveManyToManyJoinTable } from '../relations/resolve-join-table.js';

/**
 * Конструктор сущности, совместимый с YdbBaseEntity.
 */
export type YdbEntityConstructor<T extends YdbBaseEntity> = {
  new (): T;
} & typeof YdbBaseEntity;

/**
 * Контекст одной операции гидратации: identity guard против двойного
 * afterFind на одном инстансе (см. YdbEntityPersistence.hydrate).
 */
export interface HydrationContext {
  seen: WeakSet<object>;
}

/**
 * Зависимости persistence: executor и опциональные провайдеры.
 */
export interface PersistenceDeps {
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  validationProvider?: YdbValidationProvider;
  uuidGenerator?: () => string;
  /**
   * @internal Общий контекст гидратации одной операции чтения.
   * Прокидывается в persistence связанных сущностей при догрузке связей.
   */
  hydrationContext?: HydrationContext;
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
    if (ef.blindIndex) schema[blindIndexColumnName(ef.propertyKey)] = 'Utf8';
  }
  return schema;
}

export interface WhereBuildContext {
  values: Record<string, any>;
  keys: string[];
  dbSchema: Record<string, YdbPrimitive>;
  counter: number;
}

/**
 * Окружение построения одного WHERE-узла.
 *
 * `forbidEncrypted` включается внутри related-предикатов (#17): фильтрация
 * по колонкам связанных сущностей разрешена только для нешифрованных колонок
 * (blind index тоже запрещён — подзапрос по связанной таблице не имеет
 * доступа к провайдеру хешей корневого запроса и усложнил бы семантику).
 */
export interface WhereBuildEnv {
  forbidEncrypted: boolean;
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
    // Резолв учитывает ambient-контекст транзакций (#98): auto-join,
    // запрет смешивания с посторонним trx, предупреждения вне транзакции.
    const db = resolveOperationExecutor(
      trx,
      this.executor,
      this.entityClass.name,
    );
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
      query.parameter(k, mapToYdb(type, value, k));
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
        encrypted[blindIndexColumnName(ef.propertyKey)] = await provider.hash(
          String(value),
          {
            ...baseContext,
            fieldName: ef.propertyKey,
          },
        );
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
   * Проверяет, является ли ключ логическим комбинатором WHERE.
   */
  private isLogicalKey(key: string): boolean {
    return key === '$and' || key === '$or';
  }

  /**
   * Проверяет, является ли значение объектом-оператором (хотя бы один ключ начинается с $).
   */
  private isOperatorObject(value: unknown): value is Record<string, any> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const keys = Object.keys(value);
    return keys.some((k) => k.startsWith('$'));
  }

  /**
   * Нормализует значение для WHERE: enum-конвертация, JSON-сериализация.
   */
  private normalizeWhereValue(field: string, value: any): any {
    if (value === null || value === undefined) return value;
    const enums = getYdbEnumMetadata(this.entityClass);
    const enumMeta = enums.find((e) => e.propertyKey === field);
    let converted = this.convertEnumOut(value, enumMeta);
    converted = this.convertJsonOut(field, converted);
    return converted;
  }

  /**
   * Возвращает хеш blind index для зашифрованного поля.
   */
  private async hashBlindIndexForWhere(field: string, value: string) {
    const provider = this.getBlindIndexProvider();
    if (!provider) {
      throw new Error(
        `Blind index provider is not configured for entity ${this.entityClass.name} ` +
          `but it has @YdbEncrypted({ blindIndex: true }) fields. ` +
          `Pass "blindIndexProvider" in YdbCoreModule.forRootAsync() options ` +
          `or configureEntities().`,
      );
    }
    const meta = this.getMeta();
    return provider.hash(String(value), {
      entityName: this.entityClass.name,
      tableName: meta.tableName,
      fieldName: field,
      primaryKeyValue: undefined,
      aadFields: {},
    });
  }

  /**
   * Рекурсивно строит SQL-условие для одного поля.
   */
  private async buildFieldCondition(
    field: string,
    value: any,
    ctx: WhereBuildContext,
    isRoot: boolean,
    env: WhereBuildEnv,
  ): Promise<string | undefined> {
    const meta = this.getMeta();
    const dbSchema = getEntityDbSchema(meta);

    if (!dbSchema[field]) {
      throw new Error(
        `Unknown field in WHERE: "${field}" on entity ${this.entityClass.name}. ` +
          `Known fields: ${this.knownFields(meta)}. ` +
          `Check for a typo in the property name.`,
      );
    }

    // Synthetic {field}_bi колонки в related-предикатах запрещены (#17):
    // это производное шифрованного поля, а не самостоятельная колонка.
    if (env.forbidEncrypted && isSyntheticColumn(meta, field)) {
      throw new Error(
        `Cannot filter related entity ${this.entityClass.name} by blind index column "${field}": ` +
          `encrypted columns (including their blind indexes) are not allowed in related filters (#17).`,
      );
    }

    const ef = meta.encryptedFields.find((e) => e.propertyKey === field);
    const fieldType = dbSchema[field];

    // Зашифрованные поля ищутся только по blind-index (равенство).
    if (ef) {
      // В related-предикатах шифрованные поля запрещены полностью (#17).
      if (env.forbidEncrypted) {
        throw new Error(
          `Cannot filter related entity ${this.entityClass.name} by encrypted field "${field}": ` +
            `related-column filters support only non-encrypted columns (#17).`,
        );
      }
      const isEqOperatorObject =
        this.isOperatorObject(value) &&
        Object.keys(value).length === 1 &&
        '$eq' in value;
      if (this.isOperatorObject(value) && !isEqOperatorObject) {
        throw new Error(
          `Cannot use operator object on encrypted field "${field}" on entity ${this.entityClass.name}: ` +
            `only equality is supported via blind index.`,
        );
      }
      if (!ef.blindIndex) {
        throw new Error(
          `Cannot search by encrypted field "${field}" on entity ${this.entityClass.name}: ` +
            `blind index is disabled for it. ` +
            `Use @YdbEncrypted({ blindIndex: true }) to make it searchable.`,
        );
      }
      const operand = isEqOperatorObject ? value.$eq : value;
      if (operand === undefined || operand === null) {
        throw new Error(
          `Cannot search encrypted field "${field}" on entity ${this.entityClass.name} by null or undefined.`,
        );
      }
      const biField = blindIndexColumnName(field);
      const paramName = isRoot ? biField : `${biField}_${ctx.counter++}`;
      ctx.values[paramName] = await this.hashBlindIndexForWhere(
        field,
        String(operand),
      );
      ctx.keys.push(paramName);
      ctx.dbSchema[paramName] = 'Utf8';
      return `${quoteIdentifier(biField)} = $${paramName}`;
    }

    const quotedField = quoteIdentifier(field);

    if (this.isOperatorObject(value)) {
      const opEntries = Object.entries(value).filter(([k]) =>
        k.startsWith('$'),
      );
      const subConditions: string[] = [];
      for (const [op, operand] of opEntries) {
        const condition = this.buildSingleOperatorCondition(
          field,
          op,
          operand,
          ctx,
          isRoot,
        );
        if (condition) subConditions.push(condition);
      }
      if (!subConditions.length) return undefined;
      return subConditions.length === 1
        ? subConditions[0]
        : `(${subConditions.join(' AND ')})`;
    }

    // Обычное равенство
    if (value === null) return `${quotedField} IS NULL`;
    if (value === undefined) return undefined;
    const paramName = isRoot ? field : `${field}_${ctx.counter++}_eq`;
    // Корневое равенство оставляем "сырым": bindParams сам выполнит
    // enum/JSON-конвертацию по имени поля (для совместимости).
    ctx.values[paramName] = isRoot
      ? value
      : this.normalizeWhereValue(field, value);
    ctx.keys.push(paramName);
    ctx.dbSchema[paramName] = fieldType;
    return `${quotedField} = $${paramName}`;
  }

  /**
   * Проверяет, является ли колонка JSON-совместимой для JSON_EXISTS/JSON_VALUE.
   */
  private isJsonColumn(
    meta: YdbEntityMetadata,
    field: string,
    fieldType: YdbPrimitive,
  ): boolean {
    return (
      fieldType === 'Json' ||
      fieldType === 'JsonDocument' ||
      meta.jsonColumns.includes(field)
    );
  }

  /**
   * Строит условие для одного оператора над полем.
   */
  private buildSingleOperatorCondition(
    field: string,
    op: string,
    operand: any,
    ctx: WhereBuildContext,
    isRoot: boolean,
  ): string | undefined {
    const meta = this.getMeta();
    const dbSchema = getEntityDbSchema(meta);
    const fieldType = dbSchema[field];
    const quotedField = quoteIdentifier(field);
    const paramName = (suffix: string) =>
      isRoot && suffix === 'eq' ? field : `${field}_${ctx.counter++}_${suffix}`;
    const addParam = (name: string, value: any, type: YdbPrimitive) => {
      ctx.values[name] = value;
      ctx.keys.push(name);
      ctx.dbSchema[name] = type;
    };

    switch (op) {
      case '$eq': {
        if (operand === null) return `${quotedField} IS NULL`;
        if (operand === undefined) return undefined;
        const name = paramName('eq');
        addParam(
          name,
          isRoot ? operand : this.normalizeWhereValue(field, operand),
          fieldType,
        );
        return `${quotedField} = $${name}`;
      }
      case '$ne': {
        if (operand === null) return `${quotedField} IS NOT NULL`;
        if (operand === undefined) return undefined;
        const name = paramName('ne');
        addParam(name, this.normalizeWhereValue(field, operand), fieldType);
        return `${quotedField} != $${name}`;
      }
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte': {
        if (operand === null || operand === undefined) {
          throw new Error(
            `Operator "${op}" on field "${field}" requires a non-null value.`,
          );
        }
        const sqlOp =
          op === '$gt' ? '>' : op === '$gte' ? '>=' : op === '$lt' ? '<' : '<=';
        const name = paramName(op.slice(1));
        addParam(name, this.normalizeWhereValue(field, operand), fieldType);
        return `${quotedField} ${sqlOp} $${name}`;
      }
      case '$like': {
        if (typeof operand !== 'string') {
          throw new Error(
            `Operator "${op}" on field "${field}" requires a string value.`,
          );
        }
        if (fieldType !== 'Utf8') {
          throw new Error(
            `Operator "${op}" on field "${field}" requires a string column (Utf8), got "${fieldType}".`,
          );
        }
        const name = paramName('like');
        addParam(name, operand, fieldType);
        return `${quotedField} LIKE $${name}`;
      }
      case '$in': {
        if (!Array.isArray(operand) || operand.length === 0) {
          throw new Error(
            `Operator "${op}" on field "${field}" requires a non-empty array.`,
          );
        }
        const groupIdx = ctx.counter++;
        const placeholders: string[] = [];
        operand.forEach((item, i) => {
          if (item === null || item === undefined) {
            throw new Error(
              `Operator "${op}" on field "${field}" does not support null/undefined values.`,
            );
          }
          const name = `${field}_${groupIdx}_in_${i}`;
          addParam(name, this.normalizeWhereValue(field, item), fieldType);
          placeholders.push(`$${name}`);
        });
        return `${quotedField} IN (${placeholders.join(', ')})`;
      }
      case '$between': {
        if (
          !Array.isArray(operand) ||
          operand.length !== 2 ||
          operand[0] === null ||
          operand[0] === undefined ||
          operand[1] === null ||
          operand[1] === undefined
        ) {
          throw new Error(
            `Operator "${op}" on field "${field}" requires an array of two non-null values.`,
          );
        }
        const groupIdx = ctx.counter++;
        const loName = `${field}_${groupIdx}_between_lo`;
        const hiName = `${field}_${groupIdx}_between_hi`;
        addParam(
          loName,
          this.normalizeWhereValue(field, operand[0]),
          fieldType,
        );
        addParam(
          hiName,
          this.normalizeWhereValue(field, operand[1]),
          fieldType,
        );
        return `${quotedField} BETWEEN $${loName} AND $${hiName}`;
      }
      case '$jsonExists': {
        if (typeof operand !== 'string') {
          throw new Error(
            `Operator "${op}" on field "${field}" requires a string path.`,
          );
        }
        if (!this.isJsonColumn(meta, field, fieldType)) {
          throw new Error(
            `Operator "${op}" on field "${field}" requires a JSON column (Json, JsonDocument or @YdbJson), got "${fieldType}".`,
          );
        }
        const name = `${field}_${ctx.counter++}_jsonexists`;
        addParam(name, operand, 'Utf8');
        return `JSON_EXISTS(${quotedField}, $${name})`;
      }
      case '$jsonValue': {
        const { path, equals } = operand as { path: string; equals: any };
        if (typeof path !== 'string' || path.length === 0) {
          throw new Error(
            `Operator "${op}" on field "${field}" requires a non-empty string path.`,
          );
        }
        if (equals === undefined) {
          throw new Error(
            `Operator "${op}" on field "${field}" requires an "equals" value.`,
          );
        }
        if (!this.isJsonColumn(meta, field, fieldType)) {
          throw new Error(
            `Operator "${op}" on field "${field}" requires a JSON column (Json, JsonDocument or @YdbJson), got "${fieldType}".`,
          );
        }
        const groupIdx = ctx.counter++;
        const pathName = `${field}_${groupIdx}_jsonvalue_path`;
        const valName = `${field}_${groupIdx}_jsonvalue_val`;
        addParam(pathName, path, 'Utf8');
        addParam(
          valName,
          this.normalizeWhereValue(field, equals),
          fieldType === 'Json' || fieldType === 'JsonDocument'
            ? fieldType
            : 'Utf8',
        );
        return `JSON_VALUE(${quotedField}, $${pathName}) = $${valName}`;
      }
      default:
        throw new Error(
          `Unsupported WHERE operator "${op}" on field "${field}" on entity ${this.entityClass.name}.`,
        );
    }
  }

  /**
   * Рекурсивно строит SQL-условие из WHERE-объекта.
   *
   * Ключи резолвятся по приоритету: логический комбинатор ($and/$or) →
   * колонка сущности → related-фильтр (#17, свойство-связь с объектом
   * условий по колонкам связанной сущности).
   */
  private async buildWhereNode(
    node: Record<string, any>,
    ctx: WhereBuildContext,
    isRoot: boolean,
    env: WhereBuildEnv,
  ): Promise<string | undefined> {
    const parts: string[] = [];
    const dbSchema = getEntityDbSchema(this.getMeta());

    for (const [key, value] of Object.entries(node)) {
      if (value === undefined) continue;

      if (this.isLogicalKey(key)) {
        const combiner = key === '$or' ? 'OR' : 'AND';
        const list = Array.isArray(value) ? value : [value];
        if (!list.length) {
          throw new Error(
            `Logical operator "${key}" on entity ${this.entityClass.name} requires a non-empty array.`,
          );
        }
        const subs: string[] = [];
        for (const sub of list) {
          if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
            throw new Error(
              `Logical operator "${key}" on entity ${this.entityClass.name} expects objects, got ${typeof sub}.`,
            );
          }
          const subSql = await this.buildWhereNode(sub, ctx, false, env);
          if (subSql) subs.push(subSql);
        }
        if (subs.length) {
          parts.push(`(${subs.join(` ${combiner} `)})`);
        }
      } else if (!dbSchema[key] && this.findRelation(key)) {
        // Related-фильтр (#17): ключ — свойство-связь, значение — предикат
        // по колонкам связанной сущности. Колонки проверяются первыми:
        // существующее поведение для полей не меняется.
        const sql = await this.buildRelatedCondition(key, value, ctx);
        parts.push(sql);
      } else {
        const sql = await this.buildFieldCondition(
          key,
          value,
          ctx,
          isRoot,
          env,
        );
        if (sql) parts.push(sql);
      }
    }

    if (!parts.length) return undefined;
    return parts.join(' AND ');
  }

  /**
   * Общий конвейер WHERE для find/findAll/count/updateBy/deleteBy:
   * рекурсивная поддержка операторов сравнения, $in, $like, $between,
   * JSON-операторов и логических групп $and/$or.
   */
  async buildWhere(where: Record<string, any>): Promise<{
    whereClause: string;
    values: Record<string, any>;
    keys: string[];
    dbSchema: Record<string, YdbPrimitive>;
  }> {
    const meta = this.getMeta();
    const ctx: WhereBuildContext = {
      values: {},
      keys: [],
      dbSchema: { ...getEntityDbSchema(meta) },
      counter: 0,
    };

    const sql = await this.buildWhereNode(where, ctx, true, {
      forbidEncrypted: false,
    });

    return {
      whereClause: sql ? `WHERE ${sql}` : '',
      values: ctx.values,
      keys: ctx.keys,
      dbSchema: ctx.dbSchema,
    };
  }

  // ---- Related-фильтры (#17): findAll({ relation: { column: value } }) ----

  /** Ищет связь по имени свойства. */
  private findRelation(propertyKey: string): RelationMetadata | undefined {
    return getYdbRelationsMetadata(this.entityClass).find(
      (r) => r.propertyKey === propertyKey,
    );
  }

  /**
   * @internal Строит WHERE-узел предиката связанной сущности в ОБЩИЙ контекст
   * параметров родительского запроса (#17). Шифрованные колонки запрещены.
   * Вызывается на persistence-инстансе целевой сущности, поэтому enum/JSON-
   * нормализация значений работает по метаданным цели.
   */
  async buildRelatedPredicate(
    node: Record<string, any>,
    ctx: WhereBuildContext,
  ): Promise<string | undefined> {
    return this.buildWhereNode(node, ctx, false, { forbidEncrypted: true });
  }

  /**
   * Условие фильтрации корня по колонкам связанной сущности (#17).
   *
   * Стратегия — полуслияние через IN с некоррелированным подзапросом:
   * семантика EXISTS без дубликатов корневых строк. Классический EXISTS
   * не генерируется намеренно: ядро YQL не поддерживает коррелированные
   * подзапросы (ссылку на внешний запрос), а некоррелированный EXISTS
   * менял бы семантику на «существует хотя бы одна строка вообще».
   *
   * Join-колонки и пути резолвятся только из существующих метаданных связи
   * (@OneToMany/@ManyToOne/@OneToOne/@ManyToMany + @JoinTable); произвольные
   * SQL-фрагменты невозможны. Все значения биндятся через общий контекст
   * параметров (ctx) — интерполяции пользовательских значений нет.
   *
   * Поддержанные формы:
   * - one-to-many: `root.pk IN (SELECT child.fk FROM target WHERE pred)`
   * - many-to-one / one-to-one: `root.fk IN (SELECT target.pk FROM target WHERE pred)`
   * - many-to-many: `root.pk IN (SELECT jt.owner FROM jt WHERE jt.inverse IN
   *   (SELECT target.pk FROM target WHERE pred))`
   *
   * Формы, которые текущая рантайм-модель связей моделирует некорректно
   * (составные PK на стороне соединения, необъявленные join-колонки,
   * несовместимые типы, отсутствие @JoinTable), отвергаются с понятной
   * ошибкой ДО выполнения SQL.
   */
  private async buildRelatedCondition(
    relationPropertyKey: string,
    predicate: unknown,
    ctx: WhereBuildContext,
  ): Promise<string> {
    if (
      predicate === null ||
      typeof predicate !== 'object' ||
      Array.isArray(predicate)
    ) {
      const got =
        predicate === null
          ? 'null'
          : Array.isArray(predicate)
            ? 'array'
            : typeof predicate;
      throw new Error(
        `Invalid filter on relation "${relationPropertyKey}" of ${this.entityClass.name}: ` +
          `expected an object with conditions on the related entity columns, got ${got}.`,
      );
    }

    const relation = this.findRelation(relationPropertyKey);
    if (!relation) {
      throw new Error(
        `Unknown relation: "${relationPropertyKey}" on entity ${this.entityClass.name}.`,
      );
    }

    const Target = relation.target();
    const targetMeta = getYdbEntityMetadata(Target);
    if (!targetMeta) {
      throw new Error(
        `Cannot filter by relation "${relationPropertyKey}" of ${this.entityClass.name}: ` +
          `target entity ${Target.name} is not decorated with @YdbEntity.`,
      );
    }

    const rootMeta = this.getMeta();
    const relationDesc = `"${relationPropertyKey}" (${relation.type}) of ${this.entityClass.name} -> ${Target.name}`;

    // Предикат по колонкам цели строится persistence-инстансом ЦЕЛИ в общий
    // контекст параметров родителя: уникальность имён обеспечивает общий
    // счётчик, конвертация enum/JSON — метаданные цели.
    const targetPersistence = new YdbEntityPersistence(Target, undefined, {});
    const innerWhere = await targetPersistence.buildRelatedPredicate(
      predicate as Record<string, any>,
      ctx,
    );
    const innerSubquery = (selectColumn: string): string =>
      `SELECT ${quoteIdentifier(selectColumn)} FROM ${quoteIdentifier(targetMeta.tableName)}` +
      `${innerWhere ? ` WHERE ${innerWhere}` : ''}`;

    switch (relation.type) {
      case 'one-to-many': {
        if (rootMeta.primaryKeys.length !== 1) {
          throw new Error(
            `Cannot filter by one-to-many relation "${relationPropertyKey}" of ${this.entityClass.name}: ` +
              `the entity has a composite primary key (${rootMeta.primaryKeys.join(', ')}). ` +
              `The current relation model joins children by a single primary key column.`,
          );
        }
        const rootPk = rootMeta.primaryKeys[0];
        const fkColumn = resolveRelationJoinColumn(relation.joinColumn, {
          entityName: this.entityClass.name,
          relationPropertyKey,
        });
        const fkType = targetMeta.schema[fkColumn];
        if (!fkType) {
          throw new Error(
            `Invalid one-to-many relation "${relationPropertyKey}" of ${this.entityClass.name}: ` +
              `join column "${fkColumn}" is not declared on target entity ${Target.name}.`,
          );
        }
        this.assertCompatibleJoinTypes(
          relationDesc,
          `${this.entityClass.name}.${rootPk}`,
          rootMeta.schema[rootPk],
          `${Target.name}.${fkColumn}`,
          fkType,
        );
        return `${quoteIdentifier(rootPk)} IN (${innerSubquery(fkColumn)})`;
      }
      case 'many-to-one':
      case 'one-to-one': {
        const fkColumn = resolveRelationJoinColumn(relation.joinColumn, {
          entityName: this.entityClass.name,
          relationPropertyKey,
        });
        const fkType = rootMeta.schema[fkColumn];
        if (!fkType) {
          throw new Error(
            `Invalid ${relation.type} relation "${relationPropertyKey}" of ${this.entityClass.name}: ` +
              `join column "${fkColumn}" is not declared on the entity.`,
          );
        }
        if (targetMeta.primaryKeys.length !== 1) {
          throw new Error(
            `Cannot filter by ${relation.type} relation "${relationPropertyKey}" of ${this.entityClass.name}: ` +
              `target entity ${Target.name} has a composite primary key (${targetMeta.primaryKeys.join(', ')}). ` +
              `The current relation model joins parents by a single primary key column.`,
          );
        }
        const targetPk = targetMeta.primaryKeys[0];
        this.assertCompatibleJoinTypes(
          relationDesc,
          `${this.entityClass.name}.${fkColumn}`,
          fkType,
          `${Target.name}.${targetPk}`,
          targetMeta.schema[targetPk],
        );
        return `${quoteIdentifier(fkColumn)} IN (${innerSubquery(targetPk)})`;
      }
      case 'many-to-many': {
        const joinTable = resolveManyToManyJoinTable(
          this.entityClass,
          relation,
        );
        if (!joinTable) {
          throw new Error(
            `Cannot filter by many-to-many relation "${relationPropertyKey}" of ${this.entityClass.name}: ` +
              `no @JoinTable is declared for it. Filtering through many-to-many relations ` +
              `is supported from the owning side that declares the join table.`,
          );
        }
        // resolveManyToManyJoinTable гарантирует одиночные PK обеих сторон:
        // составной PK дал бы ошибку конфигурации выше по резолву.
        const rootPk = rootMeta.primaryKeys[0];
        const targetPk = targetMeta.primaryKeys[0];
        return (
          `${quoteIdentifier(rootPk)} IN (` +
          `SELECT ${quoteIdentifier(joinTable.ownerColumn)} FROM ${quoteIdentifier(joinTable.tableName)} ` +
          `WHERE ${quoteIdentifier(joinTable.inverseColumn)} IN (${innerSubquery(targetPk)}))`
        );
      }
      default:
        throw new Error(
          `Cannot filter by relation "${relationPropertyKey}" of ${this.entityClass.name}: ` +
            `unsupported relation type "${String(relation.type)}".`,
        );
    }
  }

  /**
   * Совместимость типов join-колонок для related-фильтра (#17):
   * сравнение разных YDB-типов в IN (...) упало бы уже на сервере —
   * сообщаем о конфигурации связи раньше, с именами колонок и типов.
   */
  private assertCompatibleJoinTypes(
    relationDesc: string,
    outerColumn: string,
    outerType: YdbPrimitive | undefined,
    innerColumn: string,
    innerType: YdbPrimitive | undefined,
  ): void {
    if (!outerType || !innerType) {
      throw new Error(
        `Cannot filter by relation ${relationDesc}: join column type is not declared ` +
          `(${outerColumn}, ${innerColumn}). Declare both columns via @YdbColumn/@YdbPrimaryColumn.`,
      );
    }
    if (outerType !== innerType) {
      throw new Error(
        `Cannot filter by relation ${relationDesc}: join column types differ — ` +
          `${outerColumn} is ${outerType}, ${innerColumn} is ${innerType}. ` +
          `IN (...) between different YDB types would fail at execution.`,
      );
    }
  }

  private async executeQuery<U>(
    query: YdbQuery,
    options?: QueryOptions,
  ): Promise<U> {
    return executeYdbQuery<U>(query, options);
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

  /**
   * Единый конвейер гидратации результатов SELECT: дешифровка →
   * instantiate → [eager relations] → afterFind.
   *
   * Семантика lifecycle (#83):
   * - afterFind вызывается ровно один раз для каждого инстанса в рамках
   *   операции чтения и никогда — при пустом результате;
   * - хуки корневых сущностей срабатывают после догрузки связей;
   * - связанные сущности (fetchByColumnIn) проходят тот же конвейер с
   *   `eager: false`: глубина eager остаётся равной 1, как и до #83,
   *   что исключает бесконечную рекурсию на циклических/self-referencing
   *   eager-связях.
   *
   * `hydrationContext.seen` — identity guard: инстанс, уже попавший в
   * гидратацию этой операции, не получит afterFind повторно.
   */
  private async hydrate(
    raw: Record<string, any>[],
    options?: QueryOptions,
    opts?: { eager?: boolean; afterFind?: boolean },
  ): Promise<T[]> {
    await this.decryptResult(raw);
    const result = raw.map((r) => this.instantiate(r));
    if (!result.length) return result;

    const ctx = this.options.hydrationContext ?? {
      seen: new WeakSet<object>(),
    };

    const fresh = result.filter((inst) => !ctx.seen.has(inst));
    for (const inst of fresh) ctx.seen.add(inst);
    if (!fresh.length) return result;

    if (opts?.eager ?? true) {
      await this.loadEagerRelations(fresh, options, ctx);
    }

    // afterFind может откладываться (#16): промежуточные уровни вложенного
    // eager-пути срабатывают в пост-порядке — только после догрузки своих
    // детей (см. YdbEntityRelations.loadRelationPath / fireAfterFindOn).
    if (
      (opts?.afterFind ?? true) &&
      getLifecycleHooks(this.entityClass).afterFind.length
    ) {
      for (const inst of fresh) {
        await this.callHooks('afterFind', inst);
      }
    }
    return result;
  }

  private async runValidation(entity: Record<string, any>): Promise<void> {
    const provider = this.getValidationProvider();
    if (!provider) return;
    const errors = await provider.validate(entity);
    if (errors.length) {
      throw new YdbEntityValidationError(this.entityClass.name, errors);
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
    if (!whereClause) {
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

    const [result] = await this.hydrate([raw], options);
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
    const sql = `SELECT ${selectClause} FROM ${quoteIdentifier(meta.tableName)} ${whereClause} LIMIT ${resolveRetrieveLimit(options?.limit)} OFFSET ${resolveRetrieveOffset(options?.offset)}`;

    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );

    return this.hydrate(rows[0] ?? [], options);
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

    return this.hydrate(rows[0] ?? [], options);
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

    // beforeInsert: как в insert() — до валидации, шифрования и формирования
    // параметров; мутации полей из хуков попадают в БД.
    for (const e of entities) {
      await this.callHooks('beforeInsert', e);
    }

    for (const e of entities) {
      this.requirePkValues(meta, e as Record<string, any>, 'insert');
    }

    const provider = this.getValidationProvider();
    if (provider) {
      for (const e of entities) {
        const errors = await provider.validate(e);
        if (errors.length) {
          throw new YdbEntityValidationError(this.entityClass.name, errors);
        }
      }
    }

    const dataList = await Promise.all(
      entities.map((e) =>
        this.encryptEntity({ ...(e as Record<string, any>) }, e),
      ),
    );

    const BATCH_SIZE = 100;
    const enums = getYdbEnumMetadata(this.entityClass);

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
            const enumMeta = enums.find((e) => e.propertyKey === k);
            let value = this.convertEnumOut(row[k], enumMeta);
            value = this.convertJsonOut(k, value);
            query.parameter(`${k}_${i}`, mapToYdb(dbSchema[k], value, k));
          }
        });

        await this.executeQuery(query, options);
      }
    }

    // afterInsert: только после успешного завершения всех батчей записи.
    for (const e of entities) {
      await this.callHooks('afterInsert', e);
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
          data[blindIndexColumnName(ef.propertyKey)] =
            await blindIndexProvider.hash(String(value), {
              ...context,
              fieldName: ef.propertyKey,
            });
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
      query.parameter(paramName(f), mapToYdb(dbSchema[f], filter[f], f));
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

  /**
   * Вызывает afterFind на переданных инстансах (в пост-порядке вложенного
   * eager-пути #16). Инстансы промежуточного уровня уже гидратированы с
   * `afterFind: false`, поэтому срабатывание здесь — ровно один раз.
   */
  async fireAfterFind(instances: object[]): Promise<void> {
    if (!getLifecycleHooks(this.entityClass).afterFind.length) return;
    for (const inst of instances) {
      await this.callHooks('afterFind', inst as any);
    }
  }

  // ---- Relations helpers (delegated to YdbEntityRelations at repository level) ----

  /**
   * Batch-загрузка по колонке IN (...). Используется relations-модулем.
   *
   * Guard-ы (#86):
   * - пустой список значений — пустой результат БЕЗ выполнения SQL
   *   (раньше уходил невалидный `WHERE col IN ()`);
   * - дубликаты значений убираются до построения IN (...) — они раздували
   *   список параметров и не меняли результат;
   * - значения больше MAX_IN_CLAUSE_VALUES режутся на несколько чанков
   *   (лимиты YDB на текст запроса/число параметров), результаты сливаются
   * по порядку чанков без дубликатов строк (по PK).
   *
   * `hydration.afterFind` (по умолчанию true): если false, гидратированные
   * инстансы НЕ получают afterFind сразу — их послеFind откладывается для
   * пост-порядка вложенного eager-пути (#16).
   */
  async fetchByColumnIn(
    column: string,
    values: any[],
    options?: QueryOptions,
    hydration?: { afterFind?: boolean },
  ): Promise<T[]> {
    const exec = this.getExecutor(options?.trx);
    const meta = this.getMeta();
    const columnType = meta.schema[column];
    if (!columnType) {
      throw new Error(
        `No schema for join column "${column}" on entity ${this.entityClass.name}`,
      );
    }

    const uniqueValues = dedupeInValues(values);
    if (!uniqueValues.length) return [];

    // PK для дедупликации результатов между чанками.
    const pkFields = this.getPkFields(meta);

    const result: T[] = [];
    const seenPks = new Set<string>();

    for (const chunk of chunkInValues(uniqueValues)) {
      const inParams = chunk.map((_, i) => `$p${i}`).join(', ');
      const sql = `SELECT * FROM ${quoteIdentifier(meta.tableName)} WHERE ${quoteIdentifier(column)} IN (${inParams})`;

      const query = exec([sql] as unknown as TemplateStringsArray);
      chunk.forEach((value, i) => {
        query.parameter(`p${i}`, mapToYdb(columnType, value, column));
      });

      const rows = await this.executeQuery<Record<string, any>[][]>(
        query,
        options,
      );

      // Внутренний batch-фетч связей: без вложенной догрузки eager — глубина
      // собственных eager-связей цели остаётся 1 (как до #83), иначе
      // циклические связи рекурсируют. afterFind при этом обязателен для
      // связанных сущностей (issue #83), но для промежуточных уровней
      // вложенного eager-пути (#16) его можно отложить через hydration.
      const hydrated = await this.hydrate(rows[0] ?? [], options, {
        eager: false,
        afterFind: hydration?.afterFind ?? true,
      });

      for (const entity of hydrated) {
        // Инъективный ключ идентичности PK (#86): без разделительной
        // конкатенации — 'a|b'+'c' и 'a'+'b|c' не должны совпадать.
        const key = pkIdentityKey(pkFields.map((f) => (entity as any)[f]));
        if (seenPks.has(key)) continue;
        seenPks.add(key);
        result.push(entity);
      }
    }

    return result;
  }

  /**
   * Загружает eager relations для списка сущностей.
   * Вызывается из find/findAll/executeSelect. Контекст гидратации
   * прокидывается в связанные сущности (identity guard для afterFind).
   */
  private async loadEagerRelations(
    items: T[],
    options?: QueryOptions,
    hydrationContext?: HydrationContext,
  ): Promise<void> {
    if (!items.length) return;

    const eager = getEagerRelations(this.entityClass);
    if (!eager.length) return;

    const relations = new (
      await import('../relations/entity-relations.js')
    ).YdbEntityRelations(this.entityClass, this.executor, {
      encryptionProvider: this.options.encryptionProvider,
      blindIndexProvider: this.options.blindIndexProvider,
      hydrationContext,
    });
    await relations.loadEagerRelations(items, options);
  }
}

/** Проверяет, что колонка — synthetic blind index ({field}_bi) */
export function isSyntheticColumn(
  meta: YdbEntityMetadata,
  key: string,
): boolean {
  return (
    key.endsWith(BLIND_INDEX_SUFFIX) &&
    meta.encryptedFields.some(
      (ef) => ef.blindIndex && blindIndexColumnName(ef.propertyKey) === key,
    )
  );
}

// ---- Инъективная каноническая кодировка значений PK (#86) ----
//
// Дедупликация результатов между IN(...)-чанками в fetchByColumnIn строит
// строковый ключ идентичности PK. Конкатенация с разделителем
// (`String(a) + '|' + String(b)`) НЕинъективна: ('a|b', 'c') и ('a', 'b|c')
// дают один ключ 'a|b|c' — реальная сущность теряется при слиянии чанков.
// Поэтому используется двоичная кодировка без разделителей:
// [тег типа][длина payload (4 байта, big-endian)][payload].
// Границы компонентов восстанавливаются однозначно по объявленной длине,
// типы различаются тегом, поэтому разные PK не могут дать одинаковый ключ.

const pkValueTag = {
  nullValue: 0,
  undefinedValue: 1,
  string: 2,
  number: 3,
  bigint: 4,
  boolean: 5,
  bytes: 6,
  date: 7,
} as const;

const pkTextEncoder = new TextEncoder();

/** Добавляет payload с префиксом длины (4 байта BE) — самоделимитация. */
function appendLengthPrefixed(out: number[], payload: Uint8Array): void {
  const len = payload.length;
  out.push(
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
  );
  for (let i = 0; i < len; i++) out.push(payload[i]);
}

/** IEEE-754 double как 8 байт BE. */
function appendFloat64(out: number[], value: number): void {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value);
  appendLengthPrefixed(out, new Uint8Array(buf));
}

const PK_HEX_CHARS = '0123456789abcdef';

/**
 * Канонический ключ идентичности PK: инъективное отображение кортежа
 * компонентов (string | number | bigint | boolean | Uint8Array | Date |
 * null/undefined) в hex-строку. Детерминировано: одинаковые значения —
 * одинаковый ключ, разные — гарантированно разные.
 */
export function pkIdentityKey(components: unknown[]): string {
  const out: number[] = [];
  for (const value of components) {
    if (value === null) {
      out.push(pkValueTag.nullValue);
      continue;
    }
    switch (typeof value) {
      case 'string':
        out.push(pkValueTag.string);
        appendLengthPrefixed(out, pkTextEncoder.encode(value));
        break;
      case 'number': {
        // -0 и 0 — одно значение по SameValueZero (как в Set).
        out.push(pkValueTag.number);
        appendFloat64(out, Object.is(value, -0) ? 0 : value);
        break;
      }
      case 'bigint':
        out.push(pkValueTag.bigint);
        appendLengthPrefixed(out, pkTextEncoder.encode(value.toString()));
        break;
      case 'boolean':
        out.push(pkValueTag.boolean, value ? 1 : 0);
        break;
      case 'object': {
        if (ArrayBuffer.isView(value)) {
          // Bytes-колонки YDB гидратируются в Uint8Array; сравнение
          // побайтовое (String() дал бы '[object Uint8Array]' для всех).
          const view = value;
          out.push(pkValueTag.bytes);
          appendLengthPrefixed(
            out,
            new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
          );
        } else if (value instanceof Date) {
          // Date/Datetime/Timestamp-колонки; невалидная дата — ошибка
          // конфигурации, а не источник коллизий.
          if (Number.isNaN(value.getTime())) {
            throw new Error(
              'Invalid Date in primary key component: cannot build identity key',
            );
          }
          out.push(pkValueTag.date);
          appendFloat64(out, value.getTime());
        } else {
          throw new Error(
            `Unsupported primary key component type: ${typeof value}. ` +
              'PK components must be YDB primitives',
          );
        }
        break;
      }
      case 'undefined':
        out.push(pkValueTag.undefinedValue);
        break;
      default:
        throw new Error(
          `Unsupported primary key component type: ${typeof value}. ` +
            'PK components must be YDB primitives',
        );
    }
  }

  let hex = '';
  for (const byte of out) {
    hex += PK_HEX_CHARS[byte >> 4] + PK_HEX_CHARS[byte & 0x0f];
  }
  return hex;
}
