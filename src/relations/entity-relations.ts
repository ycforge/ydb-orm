import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbEntityConstructor } from '../persistence/entity-persistence.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import {
  getYdbRelationsMetadata,
  resolveRelationJoinColumn,
  type RelationMetadata,
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
    hydration?: { afterFind?: boolean },
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
    return targetPersistence.fetchByColumnIn(
      column,
      values,
      options,
      hydration,
    );
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
    items: YdbBaseEntity[],
    Target: typeof YdbBaseEntity,
    joinTable: ResolvedJoinTable,
    ownerPks: any[],
    options?: QueryOptions,
    hydration?: { afterFind?: boolean },
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
      hydration,
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
   * Eager loading: батч IN (...) на каждый уровень связи (без N+1).
   *
   * Каждая запись @EagerLoad — путь из имён relations, разделённых точкой
   * (например `tags.owner`). Допустимая длина пути:
   * - один сегмент — классическая eager-загрузка одного уровня (как до #16);
   * - несколько сегментов — вложенная загрузка (issue #16): после загрузки
   *   первого уровня его инстансы становятся «родителями» для следующего
   *   сегмента, ключи переносятся вперёд батчами.
   */
  async loadEagerRelations(items: T[], options?: QueryOptions): Promise<void> {
    if (!items.length) return;

    const constructor = items[0].constructor as typeof YdbBaseEntity;
    const eager = getEagerRelations(constructor);
    if (!eager.length) return;

    for (const path of eager) {
      await this.loadRelationPath(items, path.split('.'), options);
    }
  }

  /**
   * Единый обход relation-пути (#16): рекурсивно загружает сегменты пути по
   * одному батчу IN (...) на уровень, перенося ключи предыдущего уровня вперёд.
   *
   * Для многоуровневых путей afterFind промежуточных инстансов откладывается
   * (afterFind: false в гидратации) и срабатывает в пост-порядке — после
   * загрузки собственных детей — через fireAfterFindOn (см. #83/#107).
   */
  private async loadRelationPath(
    items: YdbBaseEntity[],
    segments: string[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!items.length || !segments.length) return;

    const constructor = items[0].constructor as typeof YdbBaseEntity;
    const name = segments[0];
    const allRelations = getYdbRelationsMetadata(constructor);
    const rel = allRelations.find((r) => r.propertyKey === name);
    if (!rel) {
      const known = allRelations.map((r) => r.propertyKey).join(', ');
      throw new Error(
        `Unknown relation in eager path "${segments.join('.')}": ` +
          `"${name}" is not a declared relation on entity ${constructor.name}. ` +
          `Known relations: ${known || '(none)'}. Check the property name or ` +
          `declare the relation via @OneToMany/@ManyToOne/@OneToOne/@ManyToMany.`,
      );
    }

    const isIntermediate = segments.length > 1;
    const targets = await this.loadRelation(items, rel, options, {
      afterFind: !isIntermediate,
    });

    if (isIntermediate) {
      // Дети этого уровня уже загружены — пост-порядковый afterFind
      // срабатывает для этого уровня после его потомков.
      await this.loadRelationPath(targets, segments.slice(1), options);
      await this.fireAfterFindOn(targets);
    }
  }

  /**
   * Загружает ОДНУ связь для списка инстансов одним (или несколькими
   * чанками) IN (...) и возвращает свежезагруженные инстансы цели — они
   * становятся «родителями» следующего уровня вложенного eager-пути (#16).
   *
   * `hydration.afterFind:false` применяется для промежуточных уровней пути,
   * чтобы их afterFind сработал в пост-порядке (после детей).
   * `strict` (для публичной loadRelations) сохраняет прежние контракты
   * ошибок: бросает на undefined PK/FK, тогда как eager-путь их пропускает.
   */
  private async loadRelation(
    items: YdbBaseEntity[],
    rel: RelationMetadata,
    options?: QueryOptions,
    hydration: { afterFind?: boolean } = { afterFind: true },
    strict = false,
  ): Promise<YdbBaseEntity[]> {
    const Target = rel.target();
    const constructor = items[0].constructor as typeof YdbBaseEntity;

    if (rel.type === 'one-to-many') {
      const joinColumnName = resolveRelationJoinColumn(rel.joinColumn, {
        entityName: constructor.name,
        relationPropertyKey: rel.propertyKey,
      });
      const pkField = getPrimaryKey(constructor);

      if (strict) {
        for (const item of items) {
          if ((item as any)[pkField] === undefined) {
            throw new Error(
              `Cannot load one-to-many relation "${rel.propertyKey}": ` +
                `primary key "${pkField}" is undefined on ${constructor.name}`,
            );
          }
        }
      }

      // null-PK не входят в IN (...) — их группы и так пусты ([]).
      // В строгом режиме (публичный loadRelations) всё равно назначаем [],
      // как было до #16; в eager-пути пустой список ключей — просто skip.
      const pks = dedupeInValues(
        items
          .map((item) => (item as any)[pkField])
          .filter((v) => v !== undefined && v !== null),
      );
      if (!pks.length && !strict) return [];

      const children = await this.fetchByColumnIn(
        Target,
        joinColumnName,
        pks,
        options,
        hydration,
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
        (item as any)[rel.propertyKey] = group ? [...group] : [];
      }
      return children;
    }

    if (rel.type === 'many-to-many') {
      const pkField = getPrimaryKey(constructor);

      const joinTable = resolveManyToManyJoinTable(constructor, rel);
      if (!joinTable) {
        if (strict) {
          throw new Error(
            `Cannot load many-to-many relation "${rel.propertyKey}": ` +
              `join table is not defined on ${constructor.name}. ` +
              `Mark the owning side with @JoinTable.`,
          );
        }
        return [];
      }

      if (strict) {
        for (const item of items) {
          if ((item as any)[pkField] === undefined) {
            throw new Error(
              `Cannot load many-to-many relation "${rel.propertyKey}": ` +
                `primary key "${pkField}" is undefined on ${constructor.name}`,
            );
          }
        }
      }

      const pks = dedupeInValues(
        items
          .map((item) => (item as any)[pkField])
          .filter((v) => v !== undefined && v !== null),
      );
      if (!pks.length && !strict) return [];

      // Один батч-вызов на ВСЕ инстансы вместо пары запросов на каждый.
      const related = await this.loadManyToManyRelation(
        items,
        Target,
        joinTable,
        pks,
        options,
        hydration,
      );

      for (const item of items) {
        const group = related.get((item as any)[pkField]);
        (item as any)[rel.propertyKey] = group ? [...group] : [];
      }

      // Уникальные инстансы целей (по ссылке): один тег, общий для
      // нескольких владельцев, должен встретиться в следующих уровнях
      // пути ровно один раз.
      const targets: YdbBaseEntity[] = [];
      const seenInst = new Set<object>();
      for (const group of related.values()) {
        for (const entity of group) {
          if (!seenInst.has(entity)) {
            seenInst.add(entity);
            targets.push(entity);
          }
        }
      }
      return targets;
    }

    // many-to-one / one-to-one
    const joinColumnName = resolveRelationJoinColumn(rel.joinColumn, {
      entityName: constructor.name,
      relationPropertyKey: rel.propertyKey,
    });
    const targetPk = getPrimaryKey(Target);

    if (strict) {
      for (const item of items) {
        if ((item as any)[joinColumnName] === undefined) {
          throw new Error(
            `Cannot load relation "${rel.propertyKey}": ` +
              `join column "${joinColumnName}" is undefined on ${constructor.name}`,
          );
        }
      }
    }

    // null-FK не входят в IN (...) — им назначается null, как возвращал
    // find() по условию «PK = NULL» (пустой результат).
    const fks = dedupeInValues(
      items
        .map((item) => (item as any)[joinColumnName])
        .filter((v) => v !== undefined && v !== null),
    );
    if (!fks.length && !strict) return [];

    const parents = await this.fetchByColumnIn(
      Target,
      targetPk,
      fks,
      options,
      hydration,
    );

    const byPk = new Map<any, YdbBaseEntity>();
    for (const parent of parents) {
      byPk.set((parent as any)[targetPk], parent);
    }

    for (const item of items) {
      (item as any)[rel.propertyKey] =
        byPk.get((item as any)[joinColumnName]) ?? null;
    }
    return parents;
  }

  /**
   * Пост-порядковый afterFind для инстансов промежуточного уровня
   * вложенного eager-пути (#16): срабатывает после их детей.
   */
  private async fireAfterFindOn(targets: YdbBaseEntity[]): Promise<void> {
    if (!targets.length) return;
    const Target = targets[0].constructor as typeof YdbBaseEntity;
    const targetPersistence = this.createTargetPersistence(Target);
    await targetPersistence.fireAfterFind(targets);
  }

  /**
   * Явная загрузка relations для одного или нескольких инстансов.
   *
   * Батчинг (#86): для каждой связи сначала собираются все значения
   * FK/PK по массиву инстансов, затем выполняется один (или несколько
   * чанков) IN (...) запрос — как в eager-пути. Раньше каждый тип связи
   * ходил запросом НА КАЖДЫЙ инстанс: 100 записей = 100–200 запросов.
   *
   * Делегирует в общий loadRelation (#16) в строгом режиме: проверяет
   * неизвестное имя связи и сохраняет прежние контракты ошибок для
   * undefined PK/FK и отсутствующей join-таблицы.
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

      await this.loadRelation(items, rel, options, { afterFind: true }, true);
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
