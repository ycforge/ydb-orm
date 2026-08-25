import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { getRegisteredYdbEntities } from '../metadata/entity-registry.js';

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
  /**
   * Колонка, ссылающаяся на владеющую сущность
   * (по умолчанию `{ownerTable}_{pkProperty}`, #90).
   */
  joinColumn?: string;
  /**
   * Колонка, ссылающаяся на обратную сущность
   * (по умолчанию `{inverseTable}_{pkProperty}`, #90).
   */
  inverseJoinColumn?: string;
}

/** Описание join-таблицы many-to-many, вычисленное по метаданным сущностей. */
export interface ManyToManyJoinTable {
  tableName: string;
  joinColumn: string;
  inverseJoinColumn: string;
  /**
   * YDB-тип колонки, ссылающейся на владельца (#90/#87): выводится из
   * фактического PK owner-сущности. Обязателен: резолв всегда выводит тип
   * из PK или бросает понятную ошибку конфигурации — молчаливого фолбэка
   * на Uuid не существует (#87).
   */
  joinColumnType: YdbPrimitive;
  /** YDB-тип колонки, ссылающейся на inverse-сущность (аналогично #87). */
  inverseJoinColumnType: YdbPrimitive;
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

/** Контекст для сообщений об ошибках конфигурации join-колонки (#87). */
export interface JoinColumnResolutionContext {
  /** Имя класса-владельца связи. */
  entityName: string;
  /** Свойство связи (@OneToMany/@ManyToOne/@OneToOne). */
  relationPropertyKey: string;
}

/**
 * Строгий резолв декларации join-колонки связи (#87).
 *
 * Поддерживается ровно две формы:
 *  - непустая строка — имя колонки;
 *  - селектор свойства: `(target) => target.property` (точка или скобочная
 *    запись с одним чтением свойства).
 *
 * Всё остальное — ошибка конфигурации, а не молчаливая угаданная строка:
 * цепочки свойств (`x.a.b`), вызовы методов (`x.getFk()`), константы
 * (`() => 'col'`) и неиспользованный аргумент отвергаются с ошибкой,
 * называющей сущность и связь.
 *
 * Единственная точка резолва: используется рантаймом relations и
 * validateEntityMetadata — расхождений между путями нет (#87).
 */
export function resolveRelationJoinColumn(
  joinColumn: string | ((target: any) => any) | undefined | null,
  ctx: JoinColumnResolutionContext,
): string {
  const where = `relation "${ctx.relationPropertyKey}" on ${ctx.entityName}`;

  if (joinColumn === undefined || joinColumn === null) {
    throw new Error(
      `Join column is required for ${where}: ` +
        `pass a column name or a property selector (target) => target.property.`,
    );
  }

  if (typeof joinColumn === 'string') {
    if (joinColumn.trim().length === 0) {
      throw new Error(
        `Invalid join column declaration for ${where}: ` +
          `column name must be a non-empty string.`,
      );
    }
    return joinColumn;
  }

  if (typeof joinColumn !== 'function') {
    throw new Error(
      `Invalid join column declaration for ${where}: ` +
        `expected a non-empty string or a property selector ` +
        `(target) => target.property, got ${typeof joinColumn}.`,
    );
  }

  return resolvePropertySelector(joinColumn, 'join column selector', where);
}

/**
 * Строгий резолв селектора `(target) => target.property`: прокси-рекордер читает
 * ровно одно обращение к свойству. Любая другая форма (цепочка, вызов,
 * символ, вычисленное значение) даёт понятную ошибку вместо угаданной
 * строки колонки (#87).
 *
 * Единственная точка резолва property-селекторов: используется join-колонками
 * (#87) и селектором inverseSide many-to-many (metadata:dump, #37) —
 * расхождений между путями нет. `what` — название селектора в тексте ошибки
 * ("join column selector", "inverseSide selector").
 */
export function resolvePropertySelector(
  selector: (target: any) => any,
  what: string,
  where: string,
): string {
  const accessedProps: string[] = [];
  let lastNode: unknown;

  /** Маркер внутренней ошибки рекордера: отличаем её от ошибок пользователя. */
  class SelectorRejected extends Error {}

  const makeNode = (): unknown =>
    new Proxy(function joinColumnSelectorTarget() {}, {
      get: (_target, prop) => {
        if (typeof prop === 'symbol') throw new SelectorRejected();
        accessedProps.push(prop);
        lastNode = makeNode();
        return lastNode;
      },
      apply: () => {
        throw new SelectorRejected();
      },
      construct: () => {
        throw new SelectorRejected();
      },
    });

  let result: unknown;
  try {
    result = selector(makeNode());
  } catch (err) {
    if (!(err instanceof SelectorRejected)) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`${invalidSelectorMessage(what, where)} (${detail}).`);
    }
    throw new Error(invalidSelectorMessage(what, where));
  }

  if (accessedProps.length !== 1 || result !== lastNode) {
    const detail = accessedProps.length
      ? `unsupported selector form (target.${accessedProps.join('.')})`
      : 'the target argument was not used to select a property';
    throw new Error(`${invalidSelectorMessage(what, where)} — ${detail}.`);
  }

  return accessedProps[0];
}

function invalidSelectorMessage(what: string, where: string): string {
  return (
    `Invalid ${what} for ${where}: ` +
    `only direct property access is supported — (target) => target.property`
  );
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
 * Резолвит ОДНО объявление join-таблицы: владелец + конкретная m2m-связь
 * с @JoinTable. Валидирует PK обеих сторон, выводит имена колонок по
 * умолчанию из фактических PK и их YDB-типы (#90).
 *
 * Единственная точка резолва объявления: используется и генерацией схемы
 * (getManyToManyJoinTables), и рантайм-резолвом relations (#139) —
 * алгоритм открытия/валидации нигде не дублируется.
 *
 * undefined — связь не many-to-many, у сущности нет метаданных или
 * у этой связи нет собственной @JoinTable.
 */
export function resolveRelationJoinTableDefinition(
  Entity: new (...args: any[]) => any,
  relation: RelationMetadata,
): ManyToManyJoinTable | undefined {
  if (relation.type !== 'many-to-many') return undefined;

  const meta = getYdbEntityMetadata(Entity);
  if (!meta) return undefined;

  const joinTable = getYdbJoinTableMetadata(Entity).find(
    (jt) => jt.propertyKey === relation.propertyKey,
  );
  if (!joinTable) return undefined;

  const InverseEntity = relation.target();
  const inverseMeta = getYdbEntityMetadata(InverseEntity);
  if (!inverseMeta) {
    throw new Error(
      `ManyToMany relation "${relation.propertyKey}" on ${Entity.name} ` +
        `targets ${InverseEntity.name}, which is not decorated with @YdbEntity`,
    );
  }

  // Контекст связи для ошибок конфигурации (#87): ошибка всегда называет
  // сущности, свойство связи и join-таблицу, а не только одну сущность.
  const relationDesc =
    `${Entity.name}.${relation.propertyKey} -> ${InverseEntity.name} ` +
    `(join table "${joinTable.tableName}")`;

  if (meta.primaryKeys.length === 0) {
    throw new Error(
      `Cannot build many-to-many join table for relation "${relationDesc}": ` +
        `owner entity ${Entity.name} declares no primary key. ` +
        `Mark at least one column with @YdbPrimaryColumn.`,
    );
  }
  if (inverseMeta.primaryKeys.length === 0) {
    throw new Error(
      `Cannot build many-to-many join table for relation "${relationDesc}": ` +
        `inverse entity ${InverseEntity.name} declares no primary key. ` +
        `Mark at least one column with @YdbPrimaryColumn.`,
    );
  }

  // Рантайм-модель many-to-many связывает строки ровно по одному
  // значению PK с каждой стороны; составной PK породил бы join-таблицу,
  // не совпадающую с тем, что читает relations-код, — отказываем явно
  // (#90/#87). Отказ детерминирован: один и тот же резолвер используется
  // генерацией схемы, валидацией метаданных, eager loading, loadRelations
  // и рантаймом join-таблицы — частичной поддержки ни в одном пути нет.
  if (meta.primaryKeys.length > 1) {
    throw new Error(
      `Cannot build many-to-many join table for relation "${relationDesc}": ` +
        `owner entity ${Entity.name} has composite primary keys ` +
        `(${meta.primaryKeys.join(', ')}) that are not supported in ` +
        `many-to-many relations. Declare a single-column @YdbPrimaryColumn.`,
    );
  }
  if (inverseMeta.primaryKeys.length > 1) {
    throw new Error(
      `Cannot build many-to-many join table for relation "${relationDesc}": ` +
        `inverse entity ${InverseEntity.name} has composite primary keys ` +
        `(${inverseMeta.primaryKeys.join(', ')}) that are not supported in ` +
        `many-to-many relations. Declare a single-column @YdbPrimaryColumn.`,
    );
  }

  const ownerPk = meta.primaryKeys[0];
  const inversePk = inverseMeta.primaryKeys[0];

  // Имена по умолчанию выводятся из фактических PK-колонок (#90):
  // для PK "uuid" это прежние `{table}_uuid`, для остальных — `{table}_{pk}`.
  const resolvedJoinColumn =
    joinTable.joinColumn ?? defaultJoinColumnName(meta.tableName, ownerPk);
  const resolvedInverseJoinColumn =
    joinTable.inverseJoinColumn ??
    defaultJoinColumnName(inverseMeta.tableName, inversePk);

  // Тип join-колонки = точный тип PK-колонки сущности (#90/#87).
  // Вывести тип невозможно — ошибка конфигурации; молчаливого фолбэка на
  // Uuid не существует: он породил бы схему, несовместимую с данными.
  const ownerPkType = meta.schema[ownerPk];
  if (!ownerPkType) {
    throw new Error(
      `Cannot derive type of join column "${resolvedJoinColumn}" ` +
        `for relation "${relationDesc}": primary key "${ownerPk}" of ` +
        `${Entity.name} is not declared via @YdbColumn/@YdbPrimaryColumn. ` +
        `Join-table columns reuse the exact primary key type — ` +
        `there is no implicit fallback.`,
    );
  }
  const inversePkType = inverseMeta.schema[inversePk];
  if (!inversePkType) {
    throw new Error(
      `Cannot derive type of inverse join column "${resolvedInverseJoinColumn}" ` +
        `for relation "${relationDesc}": primary key "${inversePk}" of ` +
        `${InverseEntity.name} is not declared via @YdbColumn/@YdbPrimaryColumn. ` +
        `Join-table columns reuse the exact primary key type — ` +
        `there is no implicit fallback.`,
    );
  }

  return {
    tableName: joinTable.tableName,
    joinColumn: resolvedJoinColumn,
    inverseJoinColumn: resolvedInverseJoinColumn,
    joinColumnType: ownerPkType,
    inverseJoinColumnType: inversePkType,
    ownerEntity: Entity as typeof YdbBaseEntity,
    ownerTableName: meta.tableName,
    ownerProperty: relation.propertyKey,
    inverseEntity: InverseEntity,
    inverseTableName: inverseMeta.tableName,
  };
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
    const relations = getYdbRelationsMetadata(Entity);

    for (const relation of relations) {
      const definition = resolveRelationJoinTableDefinition(Entity, relation);
      if (!definition) continue;

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
 * Глобальная сверка объявления join-таблицы со всеми зарегистрированными
 * сущностями (#139): если то же имя таблицы объявлено другой связью
 * с другим физическим описанием — ошибка с перечислением определений.
 *
 * Вызывается рантайм-резолвом relations, чтобы конфликт, который отвергла
 * бы schema sync/verify/миграции, не проходил молча при чтении: локально
 * для пары (owner, inverse) объявление может быть единственным, но имя
 * таблицы уже занято расходящимся объявлением в другом месте модели.
 */
export function assertNoForeignJoinTableConflicts(
  canonical: ManyToManyJoinTable,
): void {
  for (const Entity of getRegisteredYdbEntities()) {
    const relations = getYdbRelationsMetadata(Entity);
    for (const relation of relations) {
      // Сломанные нерелевантные объявления не должны ронять чтение другой
      // связи: их отвергнет полное сканирование модели (schema sync/verify/
      // миграции) с той же ошибкой. Роняет сверку только реальный конфликт
      // имён таблиц.
      let other: ManyToManyJoinTable | undefined;
      try {
        other = resolveRelationJoinTableDefinition(Entity, relation);
      } catch {
        continue;
      }
      if (!other || other.tableName !== canonical.tableName) continue;
      // Эквивалентные (например, зеркальные) объявления разрешены.
      if (joinTableDefinitionsEquivalent(canonical, other)) continue;
      throw new Error(
        formatJoinTableConflict([canonical, other]) +
          `\nDetected while resolving runtime relation access — the same ` +
          `conflict would fail schema sync/verify/migration generation.`,
      );
    }
  }
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
