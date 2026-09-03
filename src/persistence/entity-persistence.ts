import type { AadFormat } from '../encryption/aad.js';
import {
  buildAad,
  DEFAULT_AAD_FORMAT,
  toAadString,
} from '../encryption/aad.js';
import type { YdbExecutor, YdbQuery } from '../core/interfaces.js';
import { valueIdentityKey } from '../core/value-identity.js';
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
import { getEntityRuntime } from '../entity/entity-runtime.js';
import {
  chunkInValues,
  dedupeInValues,
  resolveRetrieveLimit,
  resolveRetrieveOffset,
} from '../core/query-limits.js';
import { executeYdbQuery } from '../core/execute-query.js';
import { resolveExecutorLogger } from '../core/query-logger.js';
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
 * Entity constructor type compatible with YdbBaseEntity.
 */
export type YdbEntityConstructor<T extends YdbBaseEntity> = {
  new (): T;
} & typeof YdbBaseEntity;

/**
 * Context for a single hydration operation: an identity guard against firing
 * afterFind twice on the same instance (see YdbEntityPersistence.hydrate).
 */
export interface HydrationContext {
  seen: WeakSet<object>;
}

/**
 * Persistence dependencies: the executor plus optional providers.
 */
export interface PersistenceDeps {
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  validationProvider?: YdbValidationProvider;
  uuidGenerator?: () => string;
  /**
   * Security AAD serialization format (#165). Defaults to the safe `v2`;
   * `legacy` is intended only for a transition period (decrypting old ciphertext).
   */
  aadFormat?: AadFormat;
  /**
   * Automatic AAD format detection during decryption (#165, default true): if
   * decryption with the primary format fails, retry with the secondary one.
   * Without this, switching the default to `v2` would make rows written with
   * the old `legacy` format unreadable immediately after an upgrade. Once data
   * has been fully re-encrypted, disable it (`false`) for strict mode: format
   * failures are no longer masked, and a superficially wrong AAD throws on the
   * first exception.
   */
  aadReadFallback?: boolean;
  /**
   * @internal Shared hydration context of one read operation.
   * Forwarded to the persistence of related entities when loading relations.
   */
  hydrationContext?: HydrationContext;
}

/**
 * Per-instance lazy-decryption state: field -> ciphertext from the DB.
 * Populated at instantiate(); cleared after decryptField().
 * A WeakMap so it neither blocks garbage collection nor shows up in
 * Object.entries/toJSON.
 */
const lazyPendingCiphertext = new WeakMap<object, Map<string, any>>();

/**
 * Returns whether the instance still has any undecrypted lazy fields.
 * Exported for toJSON() in YdbBaseEntity.
 */
export function hasLazyPendingCiphertext(instance: object): boolean {
  const pending = lazyPendingCiphertext.get(instance);
  return (pending?.size ?? 0) > 0;
}

/**
 * Returns the names of the instance's undecrypted lazy fields.
 */
export function getLazyPendingFieldNames(instance: object): string[] {
  const pending = lazyPendingCiphertext.get(instance);
  return pending ? [...pending.keys()] : [];
}

/**
 * Extended schema: entity fields plus synthetic {field}_bi columns.
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
 * Environment of building a single WHERE node.
 *
 * `forbidEncrypted` is enabled inside related predicates (#17): filtering by
 * related-entity columns is allowed only for non-encrypted columns (the blind
 * index is also forbidden — a subquery against a related table has no access
 * to the root query's hash provider and would complicate the semantics).
 */
export interface WhereBuildEnv {
  forbidEncrypted: boolean;
}

/**
 * Persistence class: all CRUD operations, encryption/decryption,
 * lifecycle hooks, enum conversion, and timestamp auto-fill.
 */
export class YdbEntityPersistence<T extends YdbBaseEntity> {
  constructor(
    public readonly entityClass: YdbEntityConstructor<T>,
    private executor: YdbExecutor | undefined,
    private readonly options: PersistenceDeps = {},
  ) {}

  /** Updates the executor (called from runtime when deps change). */
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
    // Resolution accounts for the ambient transaction context (#98): auto-join,
    // rejecting mixing with a foreign trx, and warnings outside a transaction.
    // Settings come from the entity's owning configuration (#199).
    const db = resolveOperationExecutor(
      trx,
      this.executor,
      this.entityClass.name,
      getEntityRuntime(this.entityClass).transactions,
      // The configuration's own logger (#206): the warnOutsideTransaction warning
      // goes to the owning configuration's logger, not straight to the console.
      resolveExecutorLogger(this.executor),
    );
    if (!db) {
      throw new Error(
        `YDB executor not set for entity ${this.entityClass.name}. ` +
          `Register the entity via YdbOrmModule.forFeature([${this.entityClass.name}]) (NestJS) ` +
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
          `in configureEntities() options or YdbOrmModule.forRootAsync() opts (NestJS).`,
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
          `Pass "blindIndexProvider" in configureEntities() options ` +
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
   * Returns the entity's PK fields from metadata (composite primary keys are
   * supported). Throws if no primary key is declared via @YdbPrimaryColumn.
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
   * Verifies that every PK component is set on the given object and returns a
   * { pkField: value } filter. Throws a clear error if any component is
   * missing (undefined/null).
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
   * String representation of the PK for the encryption context: the values of
   * all components joined with ':'.
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
    return buildAad(
      aadFieldNames,
      (name) => entity[name],
      this.options.aadFormat ?? DEFAULT_AAD_FORMAT,
    );
  }

  /**
   * Decrypts a field with a safe AAD format transition (#165).
   *
   * The primary format comes from `buildAAD` (the `aadFormat` configuration).
   * If decryption with the primary format fails and `aadReadFallback` is
   * enabled (default true), a second attempt is made with the other format:
   * legacy rows written before v2 was introduced stay readable right after an
   * upgrade (the default switched to v2 while the DB data is still old). Fields
   * with `aadOverride` are format-independent, so a fallback is pointless and
   * only a single call is made.
   *
   * If BOTH formats fail, the error of the FIRST (configured) format is
   * returned: a double failure means not "format mismatch" but corrupted
   * ciphertext or a wrong context, so it must fail deterministically.
   */
  private async decryptWithAadFallback(
    provider: YdbEncryptionProvider,
    ciphertext: Uint8Array,
    aadOverride: string | undefined,
    names: readonly string[],
    valueOf: (name: string) => unknown,
    context: YdbEncryptionContext,
  ): Promise<string> {
    const format = this.options.aadFormat ?? DEFAULT_AAD_FORMAT;
    const primary = aadOverride ?? buildAad(names, valueOf, format);
    try {
      return await provider.decrypt(ciphertext, primary, context);
    } catch (primaryError) {
      const fallbackEnabled = this.options.aadReadFallback ?? true;
      if (aadOverride || !fallbackEnabled) throw primaryError;
      const secondary = format === 'v2' ? 'legacy' : 'v2';
      const fallback = buildAad(names, valueOf, secondary);
      try {
        return await provider.decrypt(ciphertext, fallback, context);
      } catch {
        throw primaryError;
      }
    }
  }

  /**
   * Returns a copy of the entity with encrypted fields and _bi columns.
   * The source object is not mutated: it must keep the plaintext, otherwise a
   * repeated save() would re-encrypt the ciphertext.
   * Not encrypted: undefined (the column is omitted) and null (the column is
   * cleared). An explicit null additionally clears the blind index
   * ({field}_bi = null, #175): otherwise the old hash would remain in the row
   * and a lookup of the previous plaintext would return the cleared record.
   *
   * Lazy fields: if the instance came from the DB and the field is unchanged
   * (it still holds ciphertext), it is passed through as-is — no re-encryption
   * or blind-index recalculation is needed. If the user assigned a new value,
   * it is encrypted like regular plaintext.
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
      if (av !== undefined && av !== null) aadFields[aadName] = toAadString(av);
    }

    const pendingLazy = source ? lazyPendingCiphertext.get(source) : undefined;

    const encrypted = { ...entity };
    for (const ef of meta.encryptedFields) {
      const value = entity[ef.propertyKey];
      // undefined — the field is not set, so the column is absent from the
      // result entirely (write paths filter by `!== undefined`). Omission, not clearing.
      if (value === undefined) continue;

      if (ef.lazy && pendingLazy?.get(ef.propertyKey) === value) {
        encrypted[ef.propertyKey] = value;
        continue;
      }

      // Explicit null — clearing: the ciphertext (already null in the spread)
      // AND the blind index (#175). Otherwise the old hash in {field}_bi would
      // remain and a lookup of the previous plaintext would return the cleared row.
      if (value === null) {
        if (ef.blindIndex) {
          encrypted[blindIndexColumnName(ef.propertyKey)] = null;
        }
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

  /** Decrypts fields in a query result. Null/undefined and lazy fields are skipped. */
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
        if (av !== undefined && av !== null)
          aadFields[aadName] = toAadString(av);
      }

      for (const ef of meta.encryptedFields) {
        if (ef.lazy) continue;
        const ct = row[ef.propertyKey];
        if (ct === null || ct === undefined) continue;

        row[ef.propertyKey] = await this.decryptWithAadFallback(
          encryptionProvider,
          ct as Uint8Array,
          ef.aadOverride,
          meta.aadFields,
          (name) => row[name],
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
   * Returns whether the key is a logical WHERE combinator.
   */
  private isLogicalKey(key: string): boolean {
    return key === '$and' || key === '$or';
  }

  /**
   * Returns whether the value is an operator object (at least one key starts with $).
   */
  private isOperatorObject(value: unknown): value is Record<string, any> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const keys = Object.keys(value);
    return keys.some((k) => k.startsWith('$'));
  }

  /**
   * Normalizes a value for WHERE: enum conversion, JSON serialization.
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
   * Extracts a unique scalar for an AAD field from a where predicate (#166).
   * Only a direct scalar equality or { $eq: scalar } is allowed. Anything that
   * does not select exactly one instance ($in, $between, ranges, $ne, $like,
   * logical groups, arrays, null) is rejected before the query: a record is
   * encrypted with a single AAD, while on read the AAD context differs per row
   * — decryption would return garbage or fail.
   */
  private extractUniqueAadValue(
    field: string,
    raw: unknown,
  ): { value: string } | null {
    if (raw === null || raw === undefined) return null;
    let operand = raw;
    if (this.isOperatorObject(raw)) {
      const opKeys = Object.keys(raw).filter((k) => k.startsWith('$'));
      if (opKeys.length === 1 && '$eq' in raw) {
        operand = raw.$eq;
      } else {
        throw new Error(
          `updateBy() on ${this.entityClass.name} cannot resolve a unique AAD predicate ` +
            `for field "${field}": expected a direct scalar equality or { $eq: value }, ` +
            `got ${this.formatWhereValue(raw)}`,
        );
      }
    }
    if (Array.isArray(operand) || operand === null || operand === undefined) {
      throw new Error(
        `updateBy() on ${this.entityClass.name} cannot resolve a unique AAD predicate ` +
          `for field "${field}": expected a direct scalar equality or { $eq: value }, ` +
          `got ${this.formatWhereValue(raw)}`,
      );
    }
    return { value: toAadString(operand) };
  }

  private formatWhereValue(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  /**
   * Returns the blind index hash for an encrypted field.
   */
  private async hashBlindIndexForWhere(field: string, value: string) {
    const provider = this.getBlindIndexProvider();
    if (!provider) {
      throw new Error(
        `Blind index provider is not configured for entity ${this.entityClass.name} ` +
          `but it has @YdbEncrypted({ blindIndex: true }) fields. ` +
          `Pass "blindIndexProvider" in configureEntities() options ` +
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
   * Recursively builds the SQL condition for a single field.
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

    // Synthetic {field}_bi columns are forbidden in related predicates (#17):
    // they are a derived value of an encrypted field, not a standalone column.
    if (env.forbidEncrypted && isSyntheticColumn(meta, field)) {
      throw new Error(
        `Cannot filter related entity ${this.entityClass.name} by blind index column "${field}": ` +
          `encrypted columns (including their blind indexes) are not allowed in related filters (#17).`,
      );
    }

    const ef = meta.encryptedFields.find((e) => e.propertyKey === field);
    const fieldType = dbSchema[field];

    // Encrypted fields are searchable only via their blind index (equality).
    if (ef) {
      // Inside related predicates encrypted fields are entirely forbidden (#17).
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
        const condition = await this.buildSingleOperatorCondition(
          field,
          op,
          operand,
          ctx,
          isRoot,
          env,
        );
        if (condition) subConditions.push(condition);
      }
      if (!subConditions.length) return undefined;
      return subConditions.length === 1
        ? subConditions[0]
        : `(${subConditions.join(' AND ')})`;
    }

    // Plain equality
    if (value === null) return `${quotedField} IS NULL`;
    if (value === undefined) return undefined;
    const paramName = isRoot ? field : `${field}_${ctx.counter++}_eq`;
    // Root equality is left "raw": bindParams performs the enum/JSON conversion
    // itself by field name (for compatibility).
    ctx.values[paramName] = isRoot
      ? value
      : this.normalizeWhereValue(field, value);
    ctx.keys.push(paramName);
    ctx.dbSchema[paramName] = fieldType;
    return `${quotedField} = $${paramName}`;
  }

  /**
   * Returns whether the column is JSON-compatible for JSON_EXISTS/JSON_VALUE.
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
   * Builds the condition for a single operator over a field. Logical `$and`/`$or`
   * at the field-value level (#201) recursively build nested conditions of the
   * same column — this makes JSON predicates (JSON_EXISTS/JSON_VALUE) composable.
   */
  private async buildSingleOperatorCondition(
    field: string,
    op: string,
    operand: any,
    ctx: WhereBuildContext,
    isRoot: boolean,
    env: WhereBuildEnv,
  ): Promise<string | undefined> {
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
      case '$and':
      case '$or': {
        if (!Array.isArray(operand) || operand.length === 0) {
          throw new Error(
            `Operator "${op}" on field "${field}" requires a non-empty array of conditions.`,
          );
        }
        const combiner = op === '$and' ? 'AND' : 'OR';
        const subs: string[] = [];
        for (const sub of operand) {
          const subSql = await this.buildFieldCondition(
            field,
            sub,
            ctx,
            false,
            env,
          );
          if (subSql) subs.push(subSql);
        }
        if (!subs.length) return undefined;
        return subs.length === 1 ? subs[0] : `(${subs.join(` ${combiner} `)})`;
      }
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
   * Recursively builds the SQL condition from a WHERE object.
   *
   * Keys resolve by priority: logical combinator ($and/$or) -> entity column ->
   * related filter (#17, a relation property holding conditions on the related
   * entity's columns).
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
        // Related filter (#17): the key is a relation property and the value is
        // a predicate over the related entity's columns. Columns are checked
        // first, so existing behavior for fields is unchanged.
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
   * Common WHERE pipeline for find/findAll/count/updateBy/deleteBy: recursive
   * support for comparison operators, $in, $like, $between, JSON operators,
   * and the logical groups $and/$or.
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

  // ---- Related filters (#17): findAll({ relation: { column: value } }) ----

  /** Finds a relation by its property name. */
  private findRelation(propertyKey: string): RelationMetadata | undefined {
    return getYdbRelationsMetadata(this.entityClass).find(
      (r) => r.propertyKey === propertyKey,
    );
  }

  /**
   * @internal Builds a WHERE node of a related-entity predicate into the SHARED
   * parameter context of the parent query (#17). Encrypted columns are
   * forbidden. It is invoked on the persistence instance of the target entity,
   * so enum/JSON value normalization follows the target's metadata.
   */
  async buildRelatedPredicate(
    node: Record<string, any>,
    ctx: WhereBuildContext,
  ): Promise<string | undefined> {
    return this.buildWhereNode(node, ctx, false, { forbidEncrypted: true });
  }

  /**
   * Condition to filter the root by the columns of a related entity (#17).
   *
   * Strategy: a semi-join via IN with a non-correlated subquery — EXISTS
   * semantics without duplicating root rows. A classic EXISTS is deliberately
   * not generated: the YQL core does not support correlated subqueries (a
   * reference to the outer query), and a non-correlated EXISTS would change the
   * semantics to "at least one row exists at all".
   *
   * Join columns and paths are resolved only from existing relation metadata
   * (@OneToMany/@ManyToOne/@OneToOne/@ManyToMany + @JoinTable); arbitrary SQL
   * fragments are impossible. All values are bound through the shared parameter
   * context (ctx) — there is no interpolation of user values.
   *
   * Supported forms:
   * - one-to-many: `root.pk IN (SELECT child.fk FROM target WHERE pred)`
   * - many-to-one / one-to-one: `root.fk IN (SELECT target.pk FROM target WHERE pred)`
   * - many-to-many: `root.pk IN (SELECT jt.owner FROM jt WHERE jt.inverse IN
   *   (SELECT target.pk FROM target WHERE pred))`
   *
   * Forms the current relation runtime models incorrectly (composite PKs on the
   * join side, undeclared join columns, incompatible types, missing @JoinTable)
   * are rejected with a clear error BEFORE executing the SQL.
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

    // The predicate over the target's columns is built by the TARGET's
    // persistence instance into the parent's shared parameter context: name
    // uniqueness is guaranteed by the shared counter, and enum/JSON conversion
    // by the target's metadata.
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
        // resolveManyToManyJoinTable guarantees single PKs on both sides: a
        // composite PK would have raised a configuration error earlier in the
        // resolution.
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
   * Join-column type compatibility for a related filter (#17): comparing
   * different YDB types in an IN (...) would fail only on the server, so we
   * report the relation misconfiguration earlier, with the column names and types.
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
   * Creates an entity instance from a DB row.
   * Synthetic {field}_bi columns (blind index) never end up on the instance.
   */
  instantiate(row: Record<string, any>): T {
    const meta = this.getMeta();
    const Ctor = this.entityClass as new () => T;
    const instance = new Ctor();
    const enums = getYdbEnumMetadata(this.entityClass);
    for (const [key, value] of Object.entries(row)) {
      // Only declared columns. Synthetic {field}_bi and ANY column removed from
      // the metadata (#164) are excluded from the instance — otherwise legacy
      // secrets would leak into toJSON()/JSON.stringify().
      if (!meta.schema[key]) continue;
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
   * Unified hydration pipeline for SELECT results: decryption ->
   * instantiate -> [eager relations] -> afterFind.
   *
   * Lifecycle semantics (#83):
   * - afterFind fires exactly once per instance within a read operation and
   *   never on an empty result;
   * - hooks of root entities fire after relations are loaded;
   * - related entities (fetchByColumnIn) go through the same pipeline with
   *   `eager: false`: eager depth stays 1, as before #83, which rules out
   *   infinite recursion on cyclic/self-referencing eager relations.
   *
   * `hydrationContext.seen` is an identity guard: an instance already hydrated
   * by this operation will not receive afterFind again.
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

    // afterFind can be deferred (#16): intermediate levels of a nested eager
    // path fire in post-order — only after their own children are loaded
    // (see YdbEntityRelations.loadRelationPath / fireAfterFindOn).
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

  /**
   * Default SELECT projection: only the entity's declared (physical) columns
   * (#164). SELECT * would also pull in columns removed from the metadata
   * (e.g. a legacy recovery_token) — they must not reach instances or JSON.
   */
  private buildDefaultSelect(meta: YdbEntityMetadata): string {
    return Object.keys(meta.schema).map(quoteIdentifier).join(', ');
  }

  /**
   * Finds a single entity matching the conditions, or null if none match.
   * Requires at least one non-empty WHERE condition — use findAll() to query
   * without filters.
   * @param where filter conditions (supports operators, relations, $and/$or).
   * @param options query options (limit/offset, transaction, etc.).
   * @returns the first matching entity, or null when nothing matches.
   */
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
      : this.buildDefaultSelect(meta);
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

  /**
   * Finds all entities matching the conditions. With no conditions it returns
   * the whole table's rows up to the resolveRetrieveLimit default of 100.
   * @param where filter conditions (defaults to an empty filter).
   * @param options query options (limit/offset semantics, transaction, etc.).
   * @returns the matching entities.
   */
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
      : this.buildDefaultSelect(meta);
    const sql = `SELECT ${selectClause} FROM ${quoteIdentifier(meta.tableName)} ${whereClause} LIMIT ${resolveRetrieveLimit(options?.limit)} OFFSET ${resolveRetrieveOffset(options?.offset)}`;

    const query = exec([sql] as unknown as TemplateStringsArray);
    this.bindParams(query, values, keys, dbSchema);

    const rows = await this.executeQuery<Record<string, any>[][]>(
      query,
      options,
    );

    return this.hydrate(rows[0] ?? [], options);
  }

  /**
   * Counts entities matching the conditions.
   * @param where filter conditions (defaults to an empty filter).
   * @param options query options.
   * @returns the number of matching rows.
   */
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

  /** Alias for find(). */
  async findOneBy(
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return this.find(where, options);
  }

  /** Alias for findAll(). */
  async findBy(
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.findAll(where, options);
  }

  /** Returns a fluent query builder scoped to this entity. */
  query(): YdbQueryBuilder<T> {
    return new YdbQueryBuilder<T>(this.entityClass);
  }

  /** @internal Bridge for YdbQueryBuilder. */
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

  /** @internal Bridge for YdbQueryBuilder. */
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

  /**
   * Upserts an entity: updates it if every PK component is set, otherwise
   * inserts it (auto-filling a `uuid` / timestamp columns as needed).
   * @param entity the entity to persist (mutated by timestamp/uuid fill).
   * @param options query options.
   * @returns the persisted entity.
   */
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

  /**
   * Inserts many entities in batches (grouped by identical column sets, up to
   * BATCH_SIZE rows per UPSERT). Auto-fills `uuid`/timestamp columns and runs
   * beforeInsert/afterInsert lifecycle hooks for each entity.
   * @param entities rows to insert.
   * @param options query options.
   * @returns the inserted entities (mutated by uuid/timestamp fill).
   */
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

    // beforeInsert: as in insert() — before validation, encryption and
    // parameter building; field mutations from the hooks reach the DB.
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

    // afterInsert: only after all write batches have completed successfully.
    for (const e of entities) {
      await this.callHooks('afterInsert', e);
    }

    return entities;
  }

  /**
   * Updates all rows matching `where` with the given patch (which must not
   * overlap the WHERE fields). Refuses an empty WHERE/patch or a full-table
   * update. Encrypted fields in the patch are re-encrypted with the AAD derived
   * from the fixed WHERE predicate.
   * @param where filter selecting the rows to update.
   * @param patch the fields and new values to set.
   * @param options query options.
   * @returns the number of rows updated (via RETURNING over the PK).
   */
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
        // undefined — the field is not set: exclude it from the patch
        // (omission), so the column stays untouched and neither it nor its
        // blind index enters SET (#175). null, in contrast, is an EXPLICIT
        // clearing — see below.
        if (value === undefined) {
          delete data[ef.propertyKey];
          continue;
        }

        // Explicit null — clear the ciphertext and the blind index together
        // (#175): otherwise the old hash in {field}_bi would remain and a
        // lookup of the previous plaintext would return the updated rows.
        if (value === null) {
          if (ef.blindIndex) {
            data[blindIndexColumnName(ef.propertyKey)] = null;
          }
          continue;
        }

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
          const resolved: Record<string, string> = {};
          for (const f of meta.aadFields) {
            const unique = this.extractUniqueAadValue(f, where[f]);
            if (!unique) {
              throw new Error(
                `updateBy() on ${this.entityClass.name} cannot resolve a unique AAD predicate ` +
                  `for field "${f}"`,
              );
            }
            resolved[f] = unique.value;
          }
          aadFields = resolved;
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

  /**
   * Deletes the row identified by its primary key and returns the deleted
   * entity (decrypted), or null if no such row exists. Runs beforeRemove if the
   * entity declares it.
   * @param pkValue the PK value, or an object with all PK components.
   * @param options query options.
   * @returns the deleted entity, or null when nothing matched.
   */
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

  /**
   * Deletes all rows matching `where`. Refuses an empty or ineffective WHERE to
   * prevent a full-table delete.
   * @param where filter selecting the rows to delete.
   * @param options query options.
   * @returns the number of rows deleted (via RETURNING over the PK).
   */
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
   * Decrypts a single lazy field (@YdbEncrypted({ lazy: true })) on an
   * instance. Idempotent: a subsequent call returns the cached plaintext.
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
      if (av !== undefined && av !== null) aadFields[aadName] = toAadString(av);
    }
    const pkField = this.getPkFields(meta)[0];
    const pkValue = (instance as any)[pkField];

    const plaintext = await this.decryptWithAadFallback(
      provider,
      ciphertext as Uint8Array,
      ef.aadOverride,
      meta.aadFields,
      (name) => (instance as any)[name],
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
   * Decrypts all lazy fields of an instance. Idempotent.
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
   * Fires afterFind on the given instances (in post-order of a nested eager
   * path #16). Intermediate-level instances were already hydrated with
   * `afterFind: false`, so firing here happens exactly once.
   */
  async fireAfterFind(instances: object[]): Promise<void> {
    if (!getLifecycleHooks(this.entityClass).afterFind.length) return;
    for (const inst of instances) {
      await this.callHooks('afterFind', inst as any);
    }
  }

  // ---- Relations helpers (delegated to YdbEntityRelations at repository level) ----

  /**
   * Batch load by an IN (...) column. Used by the relations module.
   *
   * Guards (#86):
   * - an empty value list returns an empty result WITHOUT executing SQL
   *   (previously an invalid `WHERE col IN ()` was sent);
   * - duplicate values are removed before building the IN (...) — they only
   *   bloated the parameter list without changing the result;
   * - more values than MAX_IN_CLAUSE_VALUES are split into several chunks
   *   (YDB limits on query text/parameter count), and results are merged in
   *   chunk order without duplicate rows (by PK).
   *
   * `hydration.afterFind` (default true): when false, hydrated instances do NOT
   * receive afterFind immediately — it is deferred for the post-order of a
   * nested eager path (#16).
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

    // PK used to deduplicate results across chunks.
    const pkFields = this.getPkFields(meta);

    const result: T[] = [];
    const seenPks = new Set<string>();

    for (const chunk of chunkInValues(uniqueValues)) {
      const inParams = chunk.map((_, i) => `$p${i}`).join(', ');
      const selectClause = this.buildDefaultSelect(meta);
      const sql = `SELECT ${selectClause} FROM ${quoteIdentifier(meta.tableName)} WHERE ${quoteIdentifier(column)} IN (${inParams})`;

      const query = exec([sql] as unknown as TemplateStringsArray);
      chunk.forEach((value, i) => {
        query.parameter(`p${i}`, mapToYdb(columnType, value, column));
      });

      const rows = await this.executeQuery<Record<string, any>[][]>(
        query,
        options,
      );

      // Internal batch fetch of relations: no nested eager loading — the depth
      // of the target's own eager relations stays 1 (as before #83), otherwise
      // cyclic relations would recurse. afterFind is mandatory for related
      // entities (issue #83), but for intermediate levels of a nested eager
      // path (#16) it can be deferred via hydration.
      const hydrated = await this.hydrate(rows[0] ?? [], options, {
        eager: false,
        afterFind: hydration?.afterFind ?? true,
      });

      for (const entity of hydrated) {
        // Injective PK identity key (#86): without delimiter concatenation —
        // 'a|b'+'c' and 'a'+'b|c' must not collide.
        const key = valueIdentityKey(pkFields.map((f) => (entity as any)[f]));
        if (seenPks.has(key)) continue;
        seenPks.add(key);
        result.push(entity);
      }
    }

    return result;
  }

  /**
   * Loads eager relations for a list of entities.
   * Called from find/findAll/executeSelect. The hydration context is forwarded
   * to related entities (identity guard for afterFind).
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

/** Returns whether the column is a synthetic blind index ({field}_bi) */
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

/**
 * Backward-compatible alias of the canonical PK key: the implementation moved
 * to core/value-identity.ts (#174) and was generalized to valueIdentityKey.
 */
export { valueIdentityKey as pkIdentityKey } from '../core/value-identity.js';
