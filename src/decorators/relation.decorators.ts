import 'reflect-metadata';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';

export const YDB_RELATIONS_KEY = 'ydb:relations';
export const YDB_JOIN_TABLES_KEY = 'ydb:joinTables';

export type RelationType =
  'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';

export interface RelationMetadata {
  propertyKey: string;
  type: RelationType;
  target: () => typeof YdbBaseEntity;
  /** Для one-to-many/many-to-one/one-to-one — FK-колонка. Для many-to-many не используется. */
  joinColumn?: string | ((target: any) => any);
  /** Для many-to-many — селектор inverse-свойства (для двунаправленных связей). */
  inverseSide?: (target: any) => string;
}

export interface JoinTableMetadata {
  propertyKey: string;
  tableName: string;
  /** Колонка, ссылающаяся на владеющую сущность (по умолчанию `{ownerTable}_uuid`). */
  joinColumn?: string;
  /** Колонка, ссылающаяся на обратную сущность (по умолчанию `{inverseTable}_uuid`). */
  inverseJoinColumn?: string;
}

/** Описание join-таблицы many-to-many, вычисленное по метаданным сущностей. */
export interface ManyToManyJoinTable {
  tableName: string;
  joinColumn: string;
  inverseJoinColumn: string;
  ownerEntity: typeof YdbBaseEntity;
  ownerTableName: string;
  ownerProperty: string;
  inverseEntity: typeof YdbBaseEntity;
  inverseTableName: string;
}

function defineRelation(prototype: object, metadata: RelationMetadata): void {
  const constructor = (prototype as any).constructor;
  const inherited: RelationMetadata[] =
    Reflect.getMetadata(YDB_RELATIONS_KEY, constructor) || [];
  const relations: RelationMetadata[] = [...inherited, metadata];
  Reflect.defineMetadata(YDB_RELATIONS_KEY, relations, constructor);
}

export function OneToMany(
  target: () => typeof YdbBaseEntity,
  joinColumn: string | ((target: any) => any),
): PropertyDecorator {
  return (prototype, propertyKey) => {
    defineRelation(prototype, {
      propertyKey: propertyKey as string,
      type: 'one-to-many',
      target,
      joinColumn,
    });
  };
}

export function ManyToOne(
  target: () => typeof YdbBaseEntity,
  joinColumn: string | ((target: any) => any),
): PropertyDecorator {
  return (prototype, propertyKey) => {
    defineRelation(prototype, {
      propertyKey: propertyKey as string,
      type: 'many-to-one',
      target,
      joinColumn,
    });
  };
}

export function OneToOne(
  target: () => typeof YdbBaseEntity,
  joinColumn: string | ((target: any) => any),
): PropertyDecorator {
  return (prototype, propertyKey) => {
    defineRelation(prototype, {
      propertyKey: propertyKey as string,
      type: 'one-to-one',
      target,
      joinColumn,
    });
  };
}

export function ManyToMany(
  target: () => typeof YdbBaseEntity,
  inverseSide?: (target: any) => string,
): PropertyDecorator {
  return (prototype, propertyKey) => {
    defineRelation(prototype, {
      propertyKey: propertyKey as string,
      type: 'many-to-many',
      target,
      inverseSide,
    });
  };
}

/**
 * Задаёт join-таблицу для many-to-many. Вешается на владеющую сторону связи.
 * @example
 *   @ManyToMany(() => Tag)
 *   @JoinTable('photo_tag')
 *   tags: Tag[];
 */
export function JoinTable(
  tableName: string,
  options?: Omit<JoinTableMetadata, 'propertyKey' | 'tableName'>,
): PropertyDecorator {
  return (prototype, propertyKey) => {
    const constructor = (prototype as any).constructor;
    const inherited: JoinTableMetadata[] =
      Reflect.getMetadata(YDB_JOIN_TABLES_KEY, constructor) || [];
    const joinTables: JoinTableMetadata[] = [
      ...inherited,
      {
        propertyKey: propertyKey as string,
        tableName,
        ...options,
      },
    ];
    Reflect.defineMetadata(YDB_JOIN_TABLES_KEY, joinTables, constructor);
  };
}

export function getYdbRelationsMetadata(target: any): RelationMetadata[] {
  return Reflect.getMetadata(YDB_RELATIONS_KEY, target) || [];
}

export function getYdbJoinTableMetadata(target: any): JoinTableMetadata[] {
  return Reflect.getMetadata(YDB_JOIN_TABLES_KEY, target) || [];
}

/**
 * Возвращает join-таблицы many-to-many, владельцами которых являются переданные сущности.
 * Обратная сторона (без @JoinTable) не порождает отдельную таблицу.
 */
export function getManyToManyJoinTables(
  entities: (new (...args: any[]) => any)[],
): ManyToManyJoinTable[] {
  const result: ManyToManyJoinTable[] = [];
  const seen = new Set<string>();

  for (const Entity of entities) {
    const meta = getYdbEntityMetadata(Entity);
    if (!meta) continue;

    const relations = getYdbRelationsMetadata(Entity);
    const joinTables = getYdbJoinTableMetadata(Entity);

    for (const relation of relations) {
      if (relation.type !== 'many-to-many') continue;

      const joinTable = joinTables.find(
        (jt) => jt.propertyKey === relation.propertyKey,
      );
      if (!joinTable) continue;

      const InverseEntity = relation.target();
      const inverseMeta = getYdbEntityMetadata(InverseEntity);
      if (!inverseMeta) {
        throw new Error(
          `ManyToMany relation "${relation.propertyKey}" on ${Entity.name} ` +
            `targets ${InverseEntity.name}, which is not decorated with @YdbEntity`,
        );
      }

      if (meta.primaryKeys.length === 0) {
        throw new Error(
          `Cannot build many-to-many join table for entity ${Entity.name}: ` +
            `no primary key is declared. Mark at least one column with @YdbPrimaryColumn.`,
        );
      }
      if (inverseMeta.primaryKeys.length === 0) {
        throw new Error(
          `Cannot build many-to-many join table for entity ${InverseEntity.name}: ` +
            `no primary key is declared. Mark at least one column with @YdbPrimaryColumn.`,
        );
      }

      const joinColumn = joinTable.joinColumn ?? `${meta.tableName}_uuid`;
      const inverseJoinColumn =
        joinTable.inverseJoinColumn ?? `${inverseMeta.tableName}_uuid`;

      if (seen.has(joinTable.tableName)) continue;
      seen.add(joinTable.tableName);

      result.push({
        tableName: joinTable.tableName,
        joinColumn,
        inverseJoinColumn,
        ownerEntity: Entity as typeof YdbBaseEntity,
        ownerTableName: meta.tableName,
        ownerProperty: relation.propertyKey,
        inverseEntity: InverseEntity,
        inverseTableName: inverseMeta.tableName,
      });
    }
  }

  return result;
}
