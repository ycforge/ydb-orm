import {
  getYdbJoinTableMetadata,
  getYdbRelationsMetadata,
  RelationMetadata,
} from '../decorators/relation.decorators.js';
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

  const pkFields = meta.primaryKeys.length ? meta.primaryKeys : ['uuid'];
  for (const pk of pkFields) {
    if (!meta.schema[pk]) {
      issues.push(
        `primary key column "${pk}" is not declared via @YdbColumn/@YdbPrimaryColumn`,
      );
    }
  }

  for (const ef of meta.encryptedFields) {
    if (!meta.schema[ef.propertyKey]) {
      issues.push(`encrypted field "${ef.propertyKey}" has no @YdbColumn`);
    }
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

  const relations = getYdbRelationsMetadata(entity);
  const joinTables = getYdbJoinTableMetadata(entity);

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

  if (rel.type === 'one-to-many') {
    const joinColumn = resolveJoinColumnName(rel);
    if (joinColumn && !targetMeta.schema[joinColumn]) {
      issues.push(
        `one-to-many "${rel.propertyKey}": join column "${joinColumn}" is not a column of ${Target.name}`,
      );
    }
  }

  if (rel.type === 'many-to-one' || rel.type === 'one-to-one') {
    const joinColumn = resolveJoinColumnName(rel);
    if (joinColumn && !schema[joinColumn]) {
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
    }
  }

  return issues;
}

/** Извлекает имя колонки из строки или селектора (x) => x.field. */
function resolveJoinColumnName(rel: RelationMetadata): string | undefined {
  if (!rel.joinColumn) return undefined;
  if (typeof rel.joinColumn === 'string') return rel.joinColumn;
  const proxy = new Proxy({}, { get: (_, prop) => prop as string });
  return rel.joinColumn(proxy);
}
