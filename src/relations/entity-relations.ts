import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbEntityConstructor } from '../persistence/entity-persistence.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import {
  assertNoForeignJoinTableConflicts,
  getManyToManyJoinTables,
  getYdbRelationsMetadata,
  resolveRelationJoinColumn,
} from '../decorators/relation.decorators.js';
import type { QueryOptions } from '../core/query-options.js';
import type { YdbExecutor } from '../core/interfaces.js';
import type { YdbPrimitive } from '../core/types.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import { YdbEntityPersistence } from '../persistence/entity-persistence.js';
import type { HydrationContext } from '../persistence/entity-persistence.js';
import { getEagerRelations } from '../decorators/eager.decorator.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import { mapToYdb } from '../core/mapper.js';

/**
 * Зависимости relations-модуля.
 */
export interface RelationsDeps {
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
  /**
   * @internal Общий контекст гидратации одной операции чтения.
   * Передаётся в persistence связанных сущностей при batch-фетче,
   * чтобы afterFind сработал ровно один раз на инстанс (см. #83).
   */
  hydrationContext?: HydrationContext;
}

/**
 * Relations-класс: eager loading, lazy loadRelations, many-to-many.
 */
export class YdbEntityRelations<T extends YdbBaseEntity> {
  constructor(
    public readonly entityClass: YdbEntityConstructor<T>,
    private executor: YdbExecutor | undefined,
    private readonly options: RelationsDeps = {},
  ) {}

  /** Обновляет executor (вызывается из runtime при смене deps). */
  setExecutor(executor: YdbExecutor | undefined): void {
    this.executor = executor;
  }

  private getExecutor(trx?: YdbExecutor): YdbExecutor | undefined {
    return trx ?? this.executor;
  }

  private createTargetPersistence(
    Target: typeof YdbBaseEntity,
    trx?: YdbExecutor,
  ): YdbEntityPersistence<YdbBaseEntity> {
    return new YdbEntityPersistence(Target, trx ?? this.executor, this.options);
  }

  /**
   * Batch-загрузка по колонке IN (...).
   */
  private async fetchByColumnIn(
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
    const targetPersistence = this.createTargetPersistence(
      Target,
      options?.trx,
    );
    return targetPersistence.fetchByColumnIn(column, values, options);
  }

  /**
   * Batch-загрузка many-to-many: join-таблица + инверсные сущности.
   * Возвращает Map<owner PK, related entities[]>.
   */
  private async loadManyToManyRelation(
    items: T[],
    Target: typeof YdbBaseEntity,
    joinTable: ResolvedJoinTable,
    ownerPks: any[],
    options?: QueryOptions,
  ): Promise<Map<any, YdbBaseEntity[]>> {
    const exec = this.getExecutor(options?.trx);
    if (!exec) {
      throw new Error(
        `YDB executor not set for entity ${this.entityClass.name}`,
      );
    }

    const inParams = ownerPks.map((_, i) => `$p${i}`).join(', ');
    const ownerPkType = joinTable.ownerColumnType;

    const sql =
      `SELECT ${quoteIdentifier(joinTable.ownerColumn)}, ` +
      `${quoteIdentifier(joinTable.inverseColumn)} ` +
      `FROM ${quoteIdentifier(joinTable.tableName)} ` +
      `WHERE ${quoteIdentifier(joinTable.ownerColumn)} IN (${inParams})`;

    const joinQuery = exec([sql] as unknown as TemplateStringsArray);
    ownerPks.forEach((value, i) => {
      joinQuery.parameter(
        `p${i}`,
        mapToYdb(ownerPkType, value, joinTable.ownerColumn),
      );
    });

    const joinRows = await this.executeQuery(joinQuery, options);
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
  async loadEagerRelations(items: T[], options?: QueryOptions): Promise<void> {
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
        const joinColumnName = resolveRelationJoinColumn(rel.joinColumn, {
          entityName: constructor.name,
          relationPropertyKey: rel.propertyKey,
        });
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
        const joinColumnName = resolveRelationJoinColumn(rel.joinColumn, {
          entityName: constructor.name,
          relationPropertyKey: rel.propertyKey,
        });
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

  /**
   * Явная загрузка relations для одного или нескольких инстансов.
   */
  async loadRelations(
    items: T[],
    relationNames: string[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!items.length) return;

    const constructor = items[0].constructor as typeof YdbBaseEntity;
    const allRelations = getYdbRelationsMetadata(constructor);

    for (const name of relationNames) {
      const rel = allRelations.find((r) => r.propertyKey === name);
      if (!rel) {
        const known = allRelations.map((r) => r.propertyKey).join(', ');
        throw new Error(
          `Unknown relation: "${name}" on entity ${constructor.name}. ` +
            `Known relations: ${known || '(none)'}. ` +
            `Check the property name or declare the relation ` +
            `via @OneToMany/@ManyToOne/@OneToOne.`,
        );
      }

      const Target = rel.target();

      if (rel.type === 'one-to-many') {
        const joinColumnName = resolveRelationJoinColumn(rel.joinColumn, {
          entityName: constructor.name,
          relationPropertyKey: rel.propertyKey,
        });
        const pkField = getPrimaryKey(constructor);

        for (const item of items) {
          const pkValue = (item as any)[pkField];
          if (pkValue === undefined) {
            throw new Error(
              `Cannot load one-to-many relation "${name}": ` +
                `primary key "${pkField}" is undefined on ${constructor.name}`,
            );
          }
          const targetPersistence = this.createTargetPersistence(
            Target,
            options?.trx,
          );
          (item as any)[name] = await targetPersistence.findAll(
            { [joinColumnName]: pkValue },
            options,
          );
        }
      } else if (rel.type === 'many-to-many') {
        const pkField = getPrimaryKey(constructor);

        // Резолв зависит только от метаданных класса — один раз на связь,
        // а не на каждый элемент (внутри проверяются конфликты объявлений).
        const joinTable = resolveManyToManyJoinTable(constructor, rel);
        if (!joinTable) {
          throw new Error(
            `Cannot load many-to-many relation "${name}": ` +
              `join table is not defined on ${constructor.name}. ` +
              `Mark the owning side with @JoinTable.`,
          );
        }

        for (const item of items) {
          const pkValue = (item as any)[pkField];
          if (pkValue === undefined) {
            throw new Error(
              `Cannot load many-to-many relation "${name}": ` +
                `primary key "${pkField}" is undefined on ${constructor.name}`,
            );
          }
          const related = await this.loadManyToManyRelation(
            [item],
            Target,
            joinTable,
            [pkValue],
            options,
          );
          (item as any)[name] = related.get(pkValue) ?? [];
        }
      } else {
        const joinColumnName = resolveRelationJoinColumn(rel.joinColumn, {
          entityName: constructor.name,
          relationPropertyKey: rel.propertyKey,
        });
        const targetPk = getPrimaryKey(Target);

        for (const item of items) {
          const fkValue = (item as any)[joinColumnName];
          if (fkValue === undefined) {
            throw new Error(
              `Cannot load relation "${name}": ` +
                `join column "${joinColumnName}" is undefined on ${constructor.name}`,
            );
          }
          const targetPersistence = this.createTargetPersistence(
            Target,
            options?.trx,
          );
          (item as any)[name] = await targetPersistence.find(
            { [targetPk]: fkValue },
            options,
          );
        }
      }
    }
  }

  private async executeQuery(
    query: any,
    options?: QueryOptions,
  ): Promise<any[][]> {
    const { signal, timeout } = options ?? {};
    if (signal) {
      if (signal.aborted) throw new Error('Query aborted by signal');
      query.signal(signal);
    }
    if (timeout && timeout > 0) {
      query.timeout(timeout);
    }
    return await query;
  }
}

/** Возвращает первый PK из метаданных. Бросает ошибку, если PK не объявлен. */
function getPrimaryKey(target: typeof YdbBaseEntity): string {
  const meta = getYdbEntityMetadata(target);
  if (!meta?.primaryKeys?.length) {
    throw new Error(`Entity ${target.name} must declare a primary key`);
  }
  return meta.primaryKeys[0];
}

/**
 * Находит метаданные join-таблицы для many-to-many,
 * ориентированные относительно запрашиваемой сущности (owner).
 *
 * Валидация и разрешение конфликтов выполняются тем же кодом, что и при
 * генерации схемы: getManyToManyJoinTables для пары сущностей. Поэтому
 * рантайм не может молча выбрать одно из расходящихся объявлений таблицы —
 * он упадёт с той же ошибкой конфликта, что и schema sync/migrations (#139).
 */
interface ResolvedJoinTable {
  tableName: string;
  ownerColumn: string;
  inverseColumn: string;
  /**
   * YDB-тип owner-колонки join-таблицы (#90): тип PK owner-сущности.
   * Схема join-таблицы (schema sync) выводит те же имена и типы, поэтому
   * чтение всегда совместимо со сгенерированной таблицей.
   */
  ownerColumnType: YdbPrimitive;
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

  // Все объявления join-таблиц, видимые для пары (владелец, inverse):
  // здесь же проверяются PK и конфликты объявлений одного имени (#90/#139).
  const definitions = getManyToManyJoinTables([owner, inverseEntity]);

  // Декларация на самом владельце для этой связи.
  const own = definitions.find(
    (d) => d.ownerEntity === owner && d.ownerProperty === relation.propertyKey,
  );
  if (own) {
    assertNoForeignJoinTableConflicts(own);
    return {
      tableName: own.tableName,
      ownerColumn: own.joinColumn,
      inverseColumn: own.inverseJoinColumn,
      // Имя, тип и сущности берутся из того же определения, по которому
      // строится схема join-таблицы (#87): расхождений между рантаймом
      // и schema sync быть не может.
      ownerColumnType: own.joinColumnType,
      ownerEntity: owner,
      inverseEntity,
    };
  }

  // Зеркальная декларация на обратной стороне: колонки разворачиваются —
  // joinColumn объявления принадлежит inverse-сущности, inverseJoinColumn — владельцу.
  const inverseOwned = definitions.find(
    (d) => d.ownerEntity === inverseEntity && d.inverseEntity === owner,
  );
  if (inverseOwned) {
    assertNoForeignJoinTableConflicts(inverseOwned);
    return {
      tableName: inverseOwned.tableName,
      ownerColumn: inverseOwned.inverseJoinColumn,
      inverseColumn: inverseOwned.joinColumn,
      // Тип owner-колонки = тип PK владельца = тип её колонки в объявлении.
      ownerColumnType: inverseOwned.inverseJoinColumnType,
      ownerEntity: owner,
      inverseEntity,
    };
  }

  return undefined;
}
