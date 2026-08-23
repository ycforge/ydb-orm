import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbEntityConstructor } from '../persistence/entity-persistence.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import {
  getYdbRelationsMetadata,
  resolveRelationJoinColumn,
} from '../decorators/relation.decorators.js';
import type { QueryOptions } from '../core/query-options.js';
import type { YdbExecutor } from '../core/interfaces.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import { YdbEntityPersistence } from '../persistence/entity-persistence.js';
import type { HydrationContext } from '../persistence/entity-persistence.js';
import { getEagerRelations } from '../decorators/eager.decorator.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import { resolveOperationExecutor } from '../transaction/transaction-context.js';
import { chunkInValues, dedupeInValues } from '../core/query-limits.js';
import { mapToYdb } from '../core/mapper.js';
import {
  resolveManyToManyJoinTable,
  type ResolvedJoinTable,
} from './resolve-join-table.js';

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
    // Ambient-контекст транзакций (#98): auto-join / запрет смешивания.
    return resolveOperationExecutor(trx, this.executor, this.entityClass.name);
  }

  private createTargetPersistence(
    Target: typeof YdbBaseEntity,
    trx?: YdbExecutor,
  ): YdbEntityPersistence<YdbBaseEntity> {
    return new YdbEntityPersistence(
      Target,
      resolveOperationExecutor(trx, this.executor, this.entityClass.name),
      this.options,
    );
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
   *
   * Батчинг и guard-ы (#86): пустой список владельцев — ноль запросов;
   * дубликаты PK владельцев убираются; join-select чанкуется по
   * MAX_IN_CLAUSE_VALUES (чанки по owner-PK не пересекаются, поэтому
   * link-строки уникальны без дополнительной дедупликации); выборка
   * инверсных сущностей идёт через fetchByColumnIn (дедупликация FK,
   * чанкинг, слияние без дубликатов).
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

    const uniqueOwnerPks = dedupeInValues(ownerPks);
    if (!uniqueOwnerPks.length) return new Map();

    const ownerPkType = joinTable.ownerColumnType;

    const links: { [key: string]: any }[] = [];
    for (const chunk of chunkInValues(uniqueOwnerPks)) {
      const inParams = chunk.map((_, i) => `$p${i}`).join(', ');

      const sql =
        `SELECT ${quoteIdentifier(joinTable.ownerColumn)}, ` +
        `${quoteIdentifier(joinTable.inverseColumn)} ` +
        `FROM ${quoteIdentifier(joinTable.tableName)} ` +
        `WHERE ${quoteIdentifier(joinTable.ownerColumn)} IN (${inParams})`;

      const joinQuery = exec([sql] as unknown as TemplateStringsArray);
      chunk.forEach((value, i) => {
        joinQuery.parameter(
          `p${i}`,
          mapToYdb(ownerPkType, value, joinTable.ownerColumn),
        );
      });

      const chunkRows = await this.executeQuery(joinQuery, options);
      // Без spread: join-таблица может быть большой, а у push(...rows)
      // есть лимит на число аргументов вызова.
      const rows = (chunkRows[0] ?? []) as { [key: string]: any }[];
      for (const row of rows) {
        links.push(row);
      }
    }

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
   *
   * Батчинг (#86): для каждой связи сначала собираются все значения
   * FK/PK по массиву инстансов, затем выполняется один (или несколько
   * чанков) IN (...) запрос — как в eager-пути. Раньше каждый тип связи
   * ходил запросом НА КАЖДЫЙ инстанс: 100 записей = 100–200 запросов.
   *
   * Семантика сохранена:
   * - one-to-many: инстанс получает все дочерние строки по своему PK
   *   (или []), как давал findAll({ fk: pk }) на каждый элемент;
   * - many-to-one / one-to-one: инстанс получает ровно одну связанную
   *   строку по FK (или null), как давал find({ pk: fk });
   * - many-to-many: группы link-строк join-таблицы, как раньше;
   * - ошибки валидации (undefined PK/FK, неизвестная связь) бросаются
   *   до выполнения запросов с прежними сообщениями;
   * - связанные сущности проходят единый конвейер гидратации
   *   (дешифровка → instantiate → afterFind), как и eager-путь.
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

        // Валидация всех инстансов ДО запросов — прежний контракт ошибок.
        for (const item of items) {
          if ((item as any)[pkField] === undefined) {
            throw new Error(
              `Cannot load one-to-many relation "${name}": ` +
                `primary key "${pkField}" is undefined on ${constructor.name}`,
            );
          }
        }

        // null-PK не входят в IN (...) — их группы и так пусты ([]).
        const pks = dedupeInValues(
          items
            .map((item) => (item as any)[pkField])
            .filter((v) => v !== undefined && v !== null),
        );

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

        // Копия массива на инстанс: два инстанса с одним PK не должны
        // разделять один массив (раньше у каждого был свой findAll).
        for (const item of items) {
          const group = byFk.get((item as any)[pkField]);
          (item as any)[name] = group ? [...group] : [];
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
          if ((item as any)[pkField] === undefined) {
            throw new Error(
              `Cannot load many-to-many relation "${name}": ` +
                `primary key "${pkField}" is undefined on ${constructor.name}`,
            );
          }
        }

        const pks = dedupeInValues(
          items
            .map((item) => (item as any)[pkField])
            .filter((v) => v !== undefined && v !== null),
        );

        // Один батч-вызов на ВСЕ инстансы вместо пары запросов на каждый.
        const related = await this.loadManyToManyRelation(
          items,
          Target,
          joinTable,
          pks,
          options,
        );

        for (const item of items) {
          const group = related.get((item as any)[pkField]);
          (item as any)[name] = group ? [...group] : [];
        }
      } else {
        const joinColumnName = resolveRelationJoinColumn(rel.joinColumn, {
          entityName: constructor.name,
          relationPropertyKey: rel.propertyKey,
        });
        const targetPk = getPrimaryKey(Target);

        for (const item of items) {
          if ((item as any)[joinColumnName] === undefined) {
            throw new Error(
              `Cannot load relation "${name}": ` +
                `join column "${joinColumnName}" is undefined on ${constructor.name}`,
            );
          }
        }

        // null-FK не входят в IN (...) — им назначается null, как возвращал
        // find() по условию «PK = NULL» (пустой результат).
        const fks = dedupeInValues(
          items
            .map((item) => (item as any)[joinColumnName])
            .filter((v) => v !== undefined && v !== null),
        );

        const parents = await this.fetchByColumnIn(
          Target,
          targetPk,
          fks,
          options,
        );

        const byPk = new Map<any, YdbBaseEntity>();
        for (const parent of parents) {
          byPk.set((parent as any)[targetPk], parent);
        }

        for (const item of items) {
          (item as any)[name] = byPk.get((item as any)[joinColumnName]) ?? null;
        }
      }
    }
  }

  private async executeQuery(
    query: any,
    options?: QueryOptions,
  ): Promise<any[][]> {
    const { signal, timeout, idempotent } = options ?? {};
    if (signal) {
      if (signal.aborted) throw new Error('Query aborted by signal');
      query.signal(signal);
    }
    if (timeout && timeout > 0) {
      query.timeout(timeout);
    }
    // Пометка идемпотентности (#27): см. core/retry-executor.
    if (idempotent === true) {
      query.idempotent?.(true);
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
