import {
  getYdbJoinTableMetadata,
  getYdbRelationsMetadata,
  resolveRelationJoinColumn,
  resolveRelationJoinTableDefinition,
  RelationMetadata,
} from '../decorators/relation.decorators.js';
import { getYdbIndexesMetadata } from '../decorators/index.decorator.js';
import { blindIndexColumnName } from '../decorators/encryption.decorator.js';
import {
  getYdbTtlMetadata,
  validateYdbTtlAgainstSchema,
} from '../decorators/ttl.decorator.js';
import { getYdbEntityMetadata } from './entity-metadata.js';
import type { YdbBaseEntity } from '../entity/base-entity.js';

/** Validation context: which providers are configured in the module. */
export interface EntityValidationContext {
  encryptionProviderConfigured: boolean;
  blindIndexProviderConfigured: boolean;
}

/** Diagnostic severity. The validation model currently distinguishes only 'error'. */
export type EntityValidationSeverity = 'error' | 'warning';

/**
 * Structured diagnostic of an issue in entity metadata (#213).
 *
 * - `code` — stable machine-readable rule code (don't change or derive
 *   from text; new rules add new codes, not parse strings).
 * - `path` — locus of the issue in metadata (entity/field/relation),
 *   when applicable; dot format, e.g., `entity.User.email`.
 * - `message` — human-readable description (legacy text).
 * - `severity` — severity; currently all issues block initialization,
 *   but the type leaves room for future warnings.
 */
export interface EntityValidationIssue {
  code: string;
  path?: string;
  message: string;
  severity: EntityValidationSeverity;
}

/**
 * Returns the legacy human-readable string representation of a
 * structured validation diagnostic.
 */
export function validationIssueToMessage(issue: EntityValidationIssue): string {
  return issue.message;
}

/**
 * Collects a list of structured diagnostics into the legacy flat list
 * of human-readable strings.
 */
export function validationIssuesToMessages(
  issues: readonly EntityValidationIssue[],
): string[] {
  return issues.map(validationIssueToMessage);
}

const ISSUE_ERROR: EntityValidationSeverity = 'error';

function entityIssue(
  entity: typeof YdbBaseEntity,
  code: string,
  message: string,
  field?: string,
): EntityValidationIssue {
  const base = `entity.${entity.name}`;
  return {
    code,
    path: field === undefined ? base : `${base}.${field}`,
    message,
    severity: ISSUE_ERROR,
  };
}

function relationIssue(
  entity: typeof YdbBaseEntity,
  code: string,
  message: string,
  propertyKey: string,
): EntityValidationIssue {
  return {
    code,
    path: `entity.${entity.name}.relation.${propertyKey}`,
    message,
    severity: ISSUE_ERROR,
  };
}

/**
 * YDB column types that cannot be used as Security AAD (#165):
 * values of these columns are objects (JSON), and toAadString has no
 * deterministic string representation for them.
 */
const AAD_UNSAFE_TYPES = new Set(['Json', 'JsonDocument']);

/**
 * Validates entity metadata on module initialization.
 * Returns the legacy flat list of human-readable strings (empty if all
 * is well) — backward compatibility with the old API.
 *
 * Structured variant with codes/paths/severity — `validateEntityMetadataIssues`.
 * Pure function, no network.
 */
export function validateEntityMetadata(
  entity: typeof YdbBaseEntity,
  ctx: EntityValidationContext,
): string[] {
  return validationIssuesToMessages(validateEntityMetadataIssues(entity, ctx));
}

/**
 * Validates entity metadata on module initialization.
 * Returns a list of structured diagnostics (empty if all is well) —
 * caller decides how to throw. Pure function, no network.
 */
export function validateEntityMetadataIssues(
  entity: typeof YdbBaseEntity,
  ctx: EntityValidationContext,
): EntityValidationIssue[] {
  const issues: EntityValidationIssue[] = [];
  const meta = getYdbEntityMetadata(entity);

  if (!meta) {
    return [
      {
        code: 'MISSING_ENTITY_DECORATOR',
        path: `entity.${entity.name}`,
        message: `Class ${entity.name} is not decorated with @YdbEntity`,
        severity: ISSUE_ERROR,
      },
    ];
  }

  const entityName = meta.target.name;

  if (meta.primaryKeys.length === 0) {
    issues.push(
      entityIssue(
        entity,
        'MISSING_PRIMARY_KEY',
        `entity "${entityName}" must declare at least one primary key via @YdbPrimaryColumn`,
      ),
    );
  }

  const pkFields = meta.primaryKeys;
  for (const pk of pkFields) {
    if (!meta.schema[pk]) {
      issues.push(
        entityIssue(
          entity,
          'PRIMARY_KEY_UNDECLARED',
          `primary key column "${pk}" is not declared via @YdbColumn/@YdbPrimaryColumn`,
          pk,
        ),
      );
    }
  }

  for (const aadField of meta.aadFields) {
    if (!pkFields.includes(aadField)) {
      issues.push(
        entityIssue(
          entity,
          'SECURITY_AAD_NOT_PRIMARY_KEY',
          `@YdbSecurityAAD field "${aadField}" must be a primary key column`,
          aadField,
        ),
      );
    }

    // AAD serializability guarantee (#165): AAD value must be a scalar
    // that toAadString converts to a string deterministically.
    // Json/JsonDocument are objects; encryption would fail at runtime every
    // time; we catch this at initialization, not on first save().
    const aadType = meta.schema[aadField];
    if (aadType && AAD_UNSAFE_TYPES.has(aadType)) {
      issues.push(
        entityIssue(
          entity,
          'SECURITY_AAD_UNSAFE_TYPE',
          `@YdbSecurityAAD field "${aadField}" has type ${aadType}, which cannot be ` +
            `serialized to AAD; use a scalar type (Uuid, Utf8, Bytes, Int32, Int64, ` +
            `Bool, Double, Float, Date, Datetime, Timestamp)`,
          aadField,
        ),
      );
    }
  }

  for (const ef of meta.encryptedFields) {
    if (pkFields.includes(ef.propertyKey)) {
      issues.push(
        entityIssue(
          entity,
          'ENCRYPTED_PRIMARY_KEY',
          `primary key "${ef.propertyKey}" cannot be encrypted (@YdbEncrypted)`,
          ef.propertyKey,
        ),
      );
    }
  }

  if (meta.encryptedFields.length && !ctx.encryptionProviderConfigured) {
    issues.push(
      entityIssue(
        entity,
        'ENCRYPTION_PROVIDER_MISSING',
        `entity has @YdbEncrypted fields, but no encryptionProvider is configured`,
      ),
    );
  }
  if (
    meta.encryptedFields.some((ef) => ef.blindIndex) &&
    !ctx.blindIndexProviderConfigured
  ) {
    issues.push(
      entityIssue(
        entity,
        'BLIND_INDEX_PROVIDER_MISSING',
        `entity has blind index fields, but no blindIndexProvider is configured`,
      ),
    );
  }

  const ttl = getYdbTtlMetadata(entity);
  if (ttl) {
    issues.push(
      ...validateYdbTtlAgainstSchema(meta.target.name, ttl, meta.schema).map(
        (message) =>
          entityIssue(entity, 'TTL_INVALID', message, `ttl.${ttl.column}`),
      ),
    );
  }

  const relations = getYdbRelationsMetadata(entity);
  const joinTables = getYdbJoinTableMetadata(entity);

  const allowedColumns = new Set([
    ...Object.keys(meta.schema),
    ...meta.encryptedFields
      .filter((ef) => ef.blindIndex)
      .map((ef) => blindIndexColumnName(ef.propertyKey)),
  ]);
  for (const idx of getYdbIndexesMetadata(entity)) {
    if (!idx.columns.length) {
      issues.push(
        entityIssue(
          entity,
          'INDEX_WITHOUT_COLUMNS',
          '@YdbIndex without columns',
        ),
      );
    }
    for (const col of idx.columns) {
      if (!allowedColumns.has(col)) {
        issues.push(
          entityIssue(
            entity,
            'INDEX_UNKNOWN_COLUMN',
            `@YdbIndex references unknown column "${col}"`,
            col,
          ),
        );
      }
    }
  }

  for (const jt of joinTables) {
    const rel = relations.find(
      (r) => r.propertyKey === jt.propertyKey && r.type === 'many-to-many',
    );
    if (!rel) {
      issues.push(
        relationIssue(
          entity,
          'JOIN_TABLE_WITHOUT_MANY_TO_MANY',
          `@JoinTable("${jt.tableName}") on "${jt.propertyKey}" without @ManyToMany`,
          jt.propertyKey,
        ),
      );
    }
  }

  for (const rel of relations) {
    issues.push(...validateRelation(entity, meta.schema, rel, ctx));
  }

  return issues;
}

function validateRelation(
  entity: typeof YdbBaseEntity,
  schema: Record<string, unknown>,
  rel: RelationMetadata,
  _ctx: EntityValidationContext,
): EntityValidationIssue[] {
  const issues: EntityValidationIssue[] = [];
  const Target = rel.target();
  const targetMeta = getYdbEntityMetadata(Target);

  if (!targetMeta) {
    issues.push(
      relationIssue(
        entity,
        'RELATION_TARGET_NOT_ENTITY',
        `relation "${rel.propertyKey}" targets ${Target.name}, which is not decorated with @YdbEntity`,
        rel.propertyKey,
      ),
    );
    return issues;
  }

  // Strict join column resolution (#87): same resolver as in runtime
  // relations. Invalid selector or missing join column — issue with
  // clear description, not a silently guessed string.
  let joinColumn: string | undefined;
  if (rel.type !== 'many-to-many') {
    try {
      joinColumn = resolveRelationJoinColumn(rel.joinColumn, {
        entityName: entity.name,
        relationPropertyKey: rel.propertyKey,
      });
    } catch (err) {
      issues.push(
        relationIssue(
          entity,
          'RELATION_JOIN_COLUMN_INVALID',
          `${rel.type} "${rel.propertyKey}": ${(err as Error).message}`,
          rel.propertyKey,
        ),
      );
    }
  }

  if (rel.type === 'one-to-many') {
    if (joinColumn !== undefined && !targetMeta.schema[joinColumn]) {
      issues.push(
        relationIssue(
          entity,
          'RELATION_JOIN_COLUMN_NOT_ON_TARGET',
          `one-to-many "${rel.propertyKey}": join column "${joinColumn}" is not a column of ${Target.name}`,
          rel.propertyKey,
        ),
      );
    }
  }

  if (rel.type === 'many-to-one' || rel.type === 'one-to-one') {
    if (joinColumn !== undefined && !schema[joinColumn]) {
      issues.push(
        relationIssue(
          entity,
          'RELATION_JOIN_COLUMN_NOT_ON_SOURCE',
          `${rel.type} "${rel.propertyKey}": join column "${joinColumn}" is not a column of ${entity.name}`,
          rel.propertyKey,
        ),
      );
    }
  }

  if (rel.type === 'many-to-many') {
    const ownJoin = getYdbJoinTableMetadata(entity).find(
      (jt) => jt.propertyKey === rel.propertyKey,
    );
    const inverseRel = getYdbRelationsMetadata(Target).find(
      (r) => r.type === 'many-to-many' && r.target() === entity,
    );
    const inverseJoin = inverseRel
      ? getYdbJoinTableMetadata(Target).find(
          (jt) => jt.propertyKey === inverseRel.propertyKey,
        )
      : undefined;

    if (ownJoin && inverseJoin) {
      issues.push(
        relationIssue(
          entity,
          'M2M_BOTH_JOIN_TABLES',
          `many-to-many "${rel.propertyKey}": both sides have @JoinTable ` +
            `(${entity.name} and ${Target.name}) — only one owning side is allowed`,
          rel.propertyKey,
        ),
      );
    } else if (!ownJoin && !inverseJoin) {
      issues.push(
        relationIssue(
          entity,
          'M2M_NO_JOIN_TABLE',
          `many-to-many "${rel.propertyKey}" requires @JoinTable on one of the sides ` +
            `(${entity.name} or ${Target.name})`,
          rel.propertyKey,
        ),
      );
    } else {
      // m2m configuration errors (no PK, composite PK, non-inferrable
      // join column type, etc.) are caught by the same resolver that
      // builds the schema and reads runtime (#87): module init fails with
      // the same error that schema sync/verify/relations would give later.
      try {
        resolveRelationJoinTableDefinition(
          ownJoin ? entity : Target,
          ownJoin ? rel : inverseRel!,
        );
      } catch (err) {
        issues.push(
          relationIssue(
            entity,
            'M2M_JOIN_TABLE_INVALID',
            (err as Error).message,
            rel.propertyKey,
          ),
        );
      }
    }
  }

  return issues;
}
