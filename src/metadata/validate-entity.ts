import {
  getYdbJoinTableMetadata,
  getYdbRelationsMetadata,
  resolveRelationJoinColumn,
  resolveRelationJoinTableDefinition,
  RelationMetadata,
} from '../decorators/relation.decorators.js';
import { getYdbIndexesMetadata } from '../decorators/index.decorator.js';
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

/**
 * Валидация метаданных сущности при инициализации модуля.
 * Возвращает список проблем (пустой, если всё в порядке) — вызывающий код
 * решает, как бросать ошибку. Чистая функция, без сети.
 */
export function validateEntityMetadata(
  entity: typeof YdbBaseEntity,
  ctx: EntityValidationContext,
): string[] {
  const issues: string[] = [];
  const meta = getYdbEntityMetadata(entity);

  if (!meta) {
    return [`Class ${entity.name} is not decorated with @YdbEntity`];
  }

  if (meta.primaryKeys.length === 0) {
    issues.push(
      `entity "${meta.target.name}" must declare at least one primary key via @YdbPrimaryColumn`,
    );
  }

  const pkFields = meta.primaryKeys;
  for (const pk of pkFields) {
    if (!meta.schema[pk]) {
      issues.push(
        `primary key column "${pk}" is not declared via @YdbColumn/@YdbPrimaryColumn`,
      );
    }
  }

  for (const aadField of meta.aadFields) {
    if (!pkFields.includes(aadField)) {
      issues.push(
        `@YdbSecurityAAD field "${aadField}" must be a primary key column`,
      );
    }
  }

  for (const ef of meta.encryptedFields) {
    if (pkFields.includes(ef.propertyKey)) {
      issues.push(
        `primary key "${ef.propertyKey}" cannot be encrypted (@YdbEncrypted)`,
      );
    }
  }

  if (meta.encryptedFields.length && !ctx.encryptionProviderConfigured) {
    issues.push(
      `entity has @YdbEncrypted fields, but no encryptionProvider is configured`,
    );
  }
  if (
    meta.encryptedFields.some((ef) => ef.blindIndex) &&
    !ctx.blindIndexProviderConfigured
  ) {
    issues.push(
      `entity has blind index fields, but no blindIndexProvider is configured`,
    );
  }

  const ttl = getYdbTtlMetadata(entity);
  if (ttl) {
    issues.push(
      ...validateYdbTtlAgainstSchema(meta.target.name, ttl, meta.schema),
    );
  }

  const relations = getYdbRelationsMetadata(entity);
  const joinTables = getYdbJoinTableMetadata(entity);

  const allowedColumns = new Set([
    ...Object.keys(meta.schema),
    ...meta.encryptedFields
      .filter((ef) => ef.blindIndex)
      .map((ef) => `${ef.propertyKey}_bi`),
  ]);
  for (const idx of getYdbIndexesMetadata(entity)) {
    if (!idx.columns.length) {
      issues.push('@YdbIndex without columns');
    }
    for (const col of idx.columns) {
      if (!allowedColumns.has(col)) {
        issues.push(`@YdbIndex references unknown column "${col}"`);
      }
    }
  }

  for (const jt of joinTables) {
    const rel = relations.find(
      (r) => r.propertyKey === jt.propertyKey && r.type === 'many-to-many',
    );
    if (!rel) {
      issues.push(
        `@JoinTable("${jt.tableName}") on "${jt.propertyKey}" without @ManyToMany`,
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
): string[] {
  const issues: string[] = [];
  const Target = rel.target();
  const targetMeta = getYdbEntityMetadata(Target);

  if (!targetMeta) {
    issues.push(
      `relation "${rel.propertyKey}" targets ${Target.name}, which is not decorated with @YdbEntity`,
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
        `${rel.type} "${rel.propertyKey}": ${(err as Error).message}`,
      );
    }
  }

  if (rel.type === 'one-to-many') {
    if (joinColumn !== undefined && !targetMeta.schema[joinColumn]) {
      issues.push(
        `one-to-many "${rel.propertyKey}": join column "${joinColumn}" is not a column of ${Target.name}`,
      );
    }
  }

  if (rel.type === 'many-to-one' || rel.type === 'one-to-one') {
    if (joinColumn !== undefined && !schema[joinColumn]) {
      issues.push(
        `${rel.type} "${rel.propertyKey}": join column "${joinColumn}" is not a column of ${entity.name}`,
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
        `many-to-many "${rel.propertyKey}": both sides have @JoinTable ` +
          `(${entity.name} and ${Target.name}) — only one owning side is allowed`,
      );
    } else if (!ownJoin && !inverseJoin) {
      issues.push(
        `many-to-many "${rel.propertyKey}" requires @JoinTable on one of the sides ` +
          `(${entity.name} or ${Target.name})`,
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
        issues.push((err as Error).message);
      }
    }
  }

  return issues;
}
