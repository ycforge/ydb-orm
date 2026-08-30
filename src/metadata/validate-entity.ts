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

/** Контекст валидации: какие провайдеры настроены в модуле. */
export interface EntityValidationContext {
  encryptionProviderConfigured: boolean;
  blindIndexProviderConfigured: boolean;
}

/** Строгость диагностики. Модель валидации сейчас различает только 'error'. */
export type EntityValidationSeverity = 'error' | 'warning';

/**
 * Структурированная диагностика проблемы в метаданных сущности (#213).
 *
 * - `code` — стабильный машинно-читаемый код правила (не менять и не
 *   выводить из текста; новые правила добавляют новые коды, а не парсят строки).
 * - `path` — локус проблемы в метаданных (сущность/поле/отношение), когда
 *   применимо; формат точечный, например `entity.User.email`.
 * - `message` — человекочитаемое описание (прежний текст).
 * - `severity` — строгость; сейчас все проблемы блокируют инициализацию,
 *   но тип оставляет место для будущих предупреждений.
 */
export interface EntityValidationIssue {
  code: string;
  path?: string;
  message: string;
  severity: EntityValidationSeverity;
}

/** Возвращает прежнее человекочитаемое представление диагностики. */
export function validationIssueToMessage(issue: EntityValidationIssue): string {
  return issue.message;
}

/** Собирает список диагностик в прежний плоский список человекочитаемых строк. */
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
 * Типы YDB-колонок, которые нельзя использовать как Security AAD (#165):
 * значения этих колонок — объекты (JSON), и toAadString не имеет для них
 * детерминированного строкового представления.
 */
const AAD_UNSAFE_TYPES = new Set(['Json', 'JsonDocument']);

/**
 * Валидация метаданных сущности при инициализации модуля.
 * Возвращает прежний плоский список человекочитаемых строк (пустой, если всё
 * в порядке) — обратная совместимость с прежним API.
 *
 * Структурированный вариант с кодами/путями/severity — `validateEntityMetadataIssues`.
 * Чистая функция, без сети.
 */
export function validateEntityMetadata(
  entity: typeof YdbBaseEntity,
  ctx: EntityValidationContext,
): string[] {
  return validationIssuesToMessages(validateEntityMetadataIssues(entity, ctx));
}

/**
 * Валидация метаданных сущности при инициализации модуля.
 * Возвращает список структурированных диагностик (пустой, если всё в порядке) —
 * вызывающий код решает, как бросать ошибку. Чистая функция, без сети.
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

    // Гарантия сериализуемости в AAD (#165): AAD-значение обязано быть
    // скаляром, который toAadString переводит в строку детерминированно.
    // Json/JsonDocument — объекты, для них шифрование упало бы в рантайме
    // каждый раз; такое определяем на инициализации, а не в первом save().
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

  // Строгий резолв join-колонки (#87): тот же резолвер, что и в рантайме
  // relations. Невалидный селектор или отсутствие join-колонки — issue с
  // понятным описанием, а не молчаливо угаданная строка.
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
      // Ошибки конфигурации m2m (нет PK, составной PK, невыводимый тип
      // join-колонки и т.п.) обнаруживаются тем же резолвером, который
      // строит схему и читает рантайм (#87): module init падает с той же
      // ошибкой, что позже дали бы schema sync/verify/relations.
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
