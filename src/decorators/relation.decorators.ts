import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';
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
  /**
   * YDB-тип колонки, ссылающейся на владельца (#90): выводится из
   * фактического PK owner-сущности, а не жёстко Uuid.
   */
  joinColumnType?: YdbPrimitive;
  /** YDB-тип колонки, ссылающейся на inverse-сущность (аналогично #90). */
  inverseJoinColumnType?: YdbPrimitive;
  ownerEntity: typeof YdbBaseEntity;
  ownerTableName: string;
  ownerProperty: string;
  inverseEntity: typeof YdbBaseEntity;
  inverseTableName: string;
}

/**
 * Имя join-колонки по умолчанию: `{tableName}_{pkProperty}` (#90).
 * Для PK с именем `uuid` это историческое `{tableName}_uuid` — существующие
 * связи сохраняют имена; для не-uuid PK имя выводится из реального свойства
 * PK вместо молчаливого предположения о `_uuid`.
 */
export function defaultJoinColumnName(
  tableName: string,
  pkProperty: string,
): string {
  return `${tableName}_${pkProperty}`;
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
 *
 * Одно имя join-таблицы может быть объявлено несколько раз (например,
 * зеркально на обеих сторонах связи или при повторе класса во входном
 * списке). Повторные объявления безопасно дедуплицируются только при
 * идентичном физическом описании (#139); расходящиеся — ошибка со списком
 * всех определений: иначе sync/migrations молча построили бы схему по
 * первому объявлению, а relations-код читал бы по другому.
 */
export function getManyToManyJoinTables(
  entities: (new (...args: any[]) => any)[],
): ManyToManyJoinTable[] {
  const groups = new Map<string, ManyToManyJoinTable[]>();

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

      // Рантайм-модель many-to-many связывает строки ровно по одному
      // значению PK с каждой стороны; составной PK породил бы join-таблицу,
      // не совпадающую с тем, что читает relations-код, — отказываем явно (#90).
      if (meta.primaryKeys.length > 1) {
        throw new Error(
          `Cannot build many-to-many join table "${joinTable.tableName}" ` +
            `for entity ${Entity.name}: composite primary keys ` +
            `(${meta.primaryKeys.join(', ')}) are not supported in ` +
            `many-to-many relations. Declare a single-column @YdbPrimaryColumn.`,
        );
      }
      if (inverseMeta.primaryKeys.length > 1) {
        throw new Error(
          `Cannot build many-to-many join table "${joinTable.tableName}" ` +
            `for entity ${InverseEntity.name}: composite primary keys ` +
            `(${inverseMeta.primaryKeys.join(', ')}) are not supported in ` +
            `many-to-many relations. Declare a single-column @YdbPrimaryColumn.`,
        );
      }

      const ownerPk = meta.primaryKeys[0];
      const inversePk = inverseMeta.primaryKeys[0];

      const ownerPkType = meta.schema[ownerPk];
      if (!ownerPkType) {
        throw new Error(
          `Cannot build many-to-many join table for entity ${Entity.name}: ` +
            `primary key column "${ownerPk}" is not declared via @YdbColumn. ` +
            `Declare it or mark another column with @YdbPrimaryColumn.`,
        );
      }
      const inversePkType = inverseMeta.schema[inversePk];
      if (!inversePkType) {
        throw new Error(
          `Cannot build many-to-many join table for entity ${InverseEntity.name}: ` +
            `primary key column "${inversePk}" is not declared via @YdbColumn. ` +
            `Declare it or mark another column with @YdbPrimaryColumn.`,
        );
      }

      // Имена по умолчанию выводятся из фактических PK-колонок (#90):
      // для PK "uuid" это прежние `{table}_uuid`, для остальных — `{table}_{pk}`.
      const joinColumn =
        joinTable.joinColumn ?? defaultJoinColumnName(meta.tableName, ownerPk);
      const inverseJoinColumn =
        joinTable.inverseJoinColumn ??
        defaultJoinColumnName(inverseMeta.tableName, inversePk);

      const definition: ManyToManyJoinTable = {
        tableName: joinTable.tableName,
        joinColumn,
        inverseJoinColumn,
        joinColumnType: ownerPkType,
        inverseJoinColumnType: inversePkType,
        ownerEntity: Entity as typeof YdbBaseEntity,
        ownerTableName: meta.tableName,
        ownerProperty: relation.propertyKey,
        inverseEntity: InverseEntity,
        inverseTableName: inverseMeta.tableName,
      };

      const group = groups.get(definition.tableName);
      if (!group) {
        groups.set(definition.tableName, [definition]);
      } else if (
        !group.some((d) => joinTableDefinitionsEquivalent(d, definition))
      ) {
        group.push(definition);
      }
    }
  }

  // Расходящиеся объявления одного имени таблицы — конфликт: физическую
  // таблицу нельзя построить двумя разными способами (#139).
  for (const group of groups.values()) {
    if (group.length > 1) {
      throw new Error(formatJoinTableConflict(group));
    }
  }

  return [...groups.values()].map(([first]) => first);
}

/**
 * Сравнивает два описания join-таблицы как ФИЗИЧЕСКУЮ таблицу (#139):
 * совпадают пары «сущность → имя колонки + тип», направление объявления
 * не важно (зеркальные декларации на обеих сторонах эквивалентны).
 * Типы выводятся из PK конкретных сущностей, поэтому сравнение покрывает
 * и семантику PK; идентичность сущностей гарантирует одинаковый источник
 * имён/типов по умолчанию.
 */
export function joinTableDefinitionsEquivalent(
  a: Pick<
    ManyToManyJoinTable,
    | 'ownerEntity'
    | 'joinColumn'
    | 'joinColumnType'
    | 'inverseEntity'
    | 'inverseJoinColumn'
    | 'inverseJoinColumnType'
  >,
  b: Pick<
    ManyToManyJoinTable,
    | 'ownerEntity'
    | 'joinColumn'
    | 'joinColumnType'
    | 'inverseEntity'
    | 'inverseJoinColumn'
    | 'inverseJoinColumnType'
  >,
): boolean {
  const sameSide = (
    e1: typeof YdbBaseEntity,
    c1: string | undefined,
    t1: YdbPrimitive | undefined,
    e2: typeof YdbBaseEntity,
    c2: string | undefined,
    t2: YdbPrimitive | undefined,
  ) => e1 === e2 && c1 === c2 && t1 === t2;

  return (
    (sameSide(
      a.ownerEntity,
      a.joinColumn,
      a.joinColumnType,
      b.ownerEntity,
      b.joinColumn,
      b.joinColumnType,
    ) &&
      sameSide(
        a.inverseEntity,
        a.inverseJoinColumn,
        a.inverseJoinColumnType,
        b.inverseEntity,
        b.inverseJoinColumn,
        b.inverseJoinColumnType,
      )) ||
    (sameSide(
      a.ownerEntity,
      a.joinColumn,
      a.joinColumnType,
      b.inverseEntity,
      b.inverseJoinColumn,
      b.inverseJoinColumnType,
    ) &&
      sameSide(
        a.inverseEntity,
        a.inverseJoinColumn,
        a.inverseJoinColumnType,
        b.ownerEntity,
        b.joinColumn,
        b.joinColumnType,
      ))
  );
}

/** Человекочитаемое описание одного определения join-таблицы (для ошибок). */
function formatJoinTableDefinition(d: ManyToManyJoinTable): string {
  return (
    `- ${d.ownerEntity.name}.${d.ownerProperty} -> ${d.inverseEntity.name} ` +
    `(columns: ${d.joinColumn}:${d.joinColumnType}, ` +
    `${d.inverseJoinColumn}:${d.inverseJoinColumnType})`
  );
}

function formatJoinTableConflict(group: ManyToManyJoinTable[]): string {
  return (
    `Conflicting definitions for many-to-many join table ` +
    `"${group[0].tableName}" (${group.length} declarations):\n` +
    group.map(formatJoinTableDefinition).join('\n') +
    `\nAll @JoinTable declarations sharing a table name must describe the ` +
    `same physical table: identical columns, types and entity pairs.`
  );
}
