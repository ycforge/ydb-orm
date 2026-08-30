import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbEntityConstructor } from '../persistence/entity-persistence.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import {
  getYdbRelationsMetadata,
  resolveRelationJoinColumn,
  type RelationMetadata,
} from '../decorators/relation.decorators.js';
import type { QueryOptions } from '../core/query-options.js';
import type { YdbExecutor, YdbQuery } from '../core/interfaces.js';
import type {
  YdbBlindIndexProvider,
  YdbEncryptionProvider,
} from '../encryption/ydb-encryption-provider.interface.js';
import { YdbEntityPersistence } from '../persistence/entity-persistence.js';
import type { HydrationContext } from '../persistence/entity-persistence.js';
import { getEagerRelations } from '../decorators/eager.decorator.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import {
  resolveOperationExecutor,
  runWithTransactionContext,
} from '../transaction/transaction-context.js';
import { chunkInValues, dedupeInValues } from '../core/query-limits.js';
import { getEntityRuntime } from '../entity/entity-runtime.js';
import { executeYdbQuery } from '../core/execute-query.js';
import { mapToYdb } from '../core/mapper.js';
import {
  resolveManyToManyJoinTable,
  type ResolvedJoinTable,
} from './resolve-join-table.js';
import { valueIdentityKey } from '../core/value-identity.js';

/** Канонический value-ключ отношений (#174): Bytes и Date сравниваются
 * по значению, а не по ссылке (гидрация создаёт независимые инстансы
 * Uint8Array/Date — по ссылке валидные связи «не находились»). */
function relationKey(value: unknown): string {
  return valueIdentityKey([value]);
}

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
    // Настройки — из конфигурации-владельца сущности (#199).
    return resolveOperationExecutor(
      trx,
      this.executor,
      this.entityClass.name,
      getEntityRuntime(this.entityClass).transactions,
    );
  }

  private createTargetPersistence(
    Target: typeof YdbBaseEntity,
    trx?: YdbExecutor,
  ): YdbEntityPersistence<YdbBaseEntity> {
    return new YdbEntityPersistence(
      Target,
      resolveOperationExecutor(
        trx,
        this.executor,
        this.entityClass.name,
        getEntityRuntime(this.entityClass).transactions,
      ),
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
   *
   * Память ограничена (#209): для многочанковых запросов (>1 чанка)
   * join-строки не материализуются полностью — два прохода по чанкам:
   * 1) собираем уникальные inverse FK, 2) после загрузки инверсных
   * сущностей снова стримим чанки и сразу заполняем result Map.
   * Для однчанковых запросов используется классический однопроходной
   * алгоритм (совместимость с существующим поведением и тестами).
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
    const inverseColumn = joinTable.inverseColumn;
    const ownerColumn = joinTable.ownerColumn;

    const chunks = chunkInValues(uniqueOwnerPks);
    const isMultiChunk = chunks.length > 1;

    if (isMultiChunk) {
      // Two-pass для больших связей: ограничиваем память (#209).
      return this.loadManyToManyRelationTwoPass(
        Target,
        joinTable,
        chunks,
        ownerPkType,
        ownerColumn,
        inverseColumn,
        options,
        hydration,
      );
    }

    // Single-pass для совместимости и малого объема.
    return this.loadManyToManyRelationSinglePass(
      Target,
      joinTable,
      chunks[0],
      ownerPkType,
      ownerColumn,
      inverseColumn,
      options,
      hydration,
    );
  }

  /**
   * Классический однопроходной алгоритм (как было до #209).
   * Материализует все link-строки одного чанка в памяти.
   */
  private async loadManyToManyRelationSinglePass(
    Target: typeof YdbBaseEntity,
    joinTable: ResolvedJoinTable,
    chunk: any[],
    ownerPkType: any,
    ownerColumn: string,
    inverseColumn: string,
    options?: QueryOptions,
    hydration?: { afterFind?: boolean },
  ): Promise<Map<any, YdbBaseEntity[]>> {
    const exec = this.getExecutor(options?.trx);
    if (!exec) {
      throw new Error(
        `YDB executor not set for entity ${this.entityClass.name}`,
      );
    }

    const inParams = chunk.map((_, i) => `$p${i}`).join(', ');

    const sql =
      `SELECT ${quoteIdentifier(ownerColumn)}, ` +
      `${quoteIdentifier(inverseColumn)} ` +
      `FROM ${quoteIdentifier(joinTable.tableName)} ` +
      `WHERE ${quoteIdentifier(ownerColumn)} IN (${inParams})`;

    const joinQuery = exec([sql] as unknown as TemplateStringsArray);
    chunk.forEach((value, i) => {
      joinQuery.parameter(`p${i}`, mapToYdb(ownerPkType, value, ownerColumn));
    });

    const chunkRows = await this.executeQuery(joinQuery, options);
    const rows = (chunkRows[0] ?? []) as { [key: string]: any }[];

    const inverseFks = rows
      .map((row) => row[inverseColumn])
      .filter((v) => v !== undefined && v !== null);

    const targetPkField = getPrimaryKey(Target);
    const relatedEntities = await this.fetchByColumnIn(
      Target,
      targetPkField,
      inverseFks,
      options,
      hydration,
    );

    const byInversePk = new Map<string, YdbBaseEntity>();
    for (const entity of relatedEntities) {
      byInversePk.set(relationKey((entity as any)[targetPkField]), entity);
    }

    const result = new Map<string, YdbBaseEntity[]>();
    for (const row of rows) {
      const ownerFk = row[ownerColumn];
      const inverseFk = row[inverseColumn];
      if (inverseFk === undefined || inverseFk === null) continue;
      const entity = byInversePk.get(relationKey(inverseFk));
      if (!entity) continue;
      const group = result.get(relationKey(ownerFk));
      if (group) {
        group.push(entity);
      } else {
        result.set(relationKey(ownerFk), [entity]);
      }
    }

    return result;
  }

  /**
   * Двухпроходной алгоритм для многочанковых запросов (#209).
   * Pass 1: собираем уникальные inverse FK.
   * Pass 2: после загрузки инверсных сущностей заполняем result Map.
   */
  private async loadManyToManyRelationTwoPass(
    Target: typeof YdbBaseEntity,
    joinTable: ResolvedJoinTable,
    chunks: any[][],
    ownerPkType: any,
    ownerColumn: string,
    inverseColumn: string,
    options?: QueryOptions,
    hydration?: { afterFind?: boolean },
  ): Promise<Map<any, YdbBaseEntity[]>> {
    const exec = this.getExecutor(options?.trx);
    if (!exec) {
      throw new Error(
        `YDB executor not set for entity ${this.entityClass.name}`,
      );
    }

    // Pass 1: stream join-table chunks, collect unique inverse FKs
    // with their original values (key -> original value).
    const inverseFkMap = new Map<string, any>();
    for (const chunk of chunks) {
      const inParams = chunk.map((_, i) => `$p${i}`).join(', ');

      const sql =
        `SELECT ${quoteIdentifier(ownerColumn)}, ` +
        `${quoteIdentifier(inverseColumn)} ` +
        `FROM ${quoteIdentifier(joinTable.tableName)} ` +
        `WHERE ${quoteIdentifier(ownerColumn)} IN (${inParams})`;

      const joinQuery = exec([sql] as unknown as TemplateStringsArray);
      chunk.forEach((value, i) => {
        joinQuery.parameter(`p${i}`, mapToYdb(ownerPkType, value, ownerColumn));
      });

      const chunkRows = await this.executeQuery(joinQuery, options);
      const rows = (chunkRows[0] ?? []) as { [key: string]: any }[];
      for (const row of rows) {
        const inverseFk = row[inverseColumn];
        if (inverseFk !== undefined && inverseFk !== null) {
          const key = relationKey(inverseFk);
          if (!inverseFkMap.has(key)) {
            inverseFkMap.set(key, inverseFk);
          }
        }
      }
    }

    // Fetch inverse entities (batched, deduped via fetchByColumnIn).
    const targetPkField = getPrimaryKey(Target);
    const inverseFks = [...inverseFkMap.values()];
    const relatedEntities = await this.fetchByColumnIn(
      Target,
      targetPkField,
      inverseFks,
      options,
      hydration,
    );

    const byInversePk = new Map<string, YdbBaseEntity>();
    for (const entity of relatedEntities) {
      byInversePk.set(relationKey((entity as any)[targetPkField]), entity);
    }

    // Pass 2: stream join-table chunks again, directly populate result Map.
    const result = new Map<string, YdbBaseEntity[]>();
    // Для защиты от дублей на случай некорректных данных в join-таблице
    // или проблем с моками в тестах: отслеживаем добавленные inverseKey на owner.
    const addedPerOwner = new Map<string, Set<string>>();
    for (const chunk of chunks) {
      const inParams = chunk.map((_, i) => `$p${i}`).join(', ');

      const sql =
        `SELECT ${quoteIdentifier(ownerColumn)}, ` +
        `${quoteIdentifier(inverseColumn)} ` +
        `FROM ${quoteIdentifier(joinTable.tableName)} ` +
        `WHERE ${quoteIdentifier(ownerColumn)} IN (${inParams})`;

      const joinQuery = exec([sql] as unknown as TemplateStringsArray);
      chunk.forEach((value, i) => {
        joinQuery.parameter(`p${i}`, mapToYdb(ownerPkType, value, ownerColumn));
      });

      const chunkRows = await this.executeQuery(joinQuery, options);
      const rows = (chunkRows[0] ?? []) as { [key: string]: any }[];
      for (const row of rows) {
        const ownerFk = row[ownerColumn];
        const inverseFk = row[inverseColumn];
        if (inverseFk === undefined || inverseFk === null) continue;
        const entity = byInversePk.get(relationKey(inverseFk));
        if (!entity) continue;
        const ownerKey = relationKey(ownerFk);
        const inverseKey = relationKey(inverseFk);
        let added = addedPerOwner.get(ownerKey);
        if (!added) {
          added = new Set();
          addedPerOwner.set(ownerKey, added);
        }
        if (added.has(inverseKey)) continue;
        added.add(inverseKey);
        const group = result.get(ownerKey);
        if (group) {
          group.push(entity);
        } else {
          result.set(ownerKey, [entity]);
        }
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
   *
   * Явный { trx } пробрасывается во ВЕСЬ обход (#16): на время многоуровневого
   * пути открывается внутренний транзакционный контекст (per-call ambient из
   * #98), поэтому запросы БЕЗ явного { trx } — включая те, что запускают
   * afterFind-хуки промежуточных уровней — выполняются через тот же executor
   * транзакции. Глобальный ambient для этого не нужен и не меняется; новая
   * транзакция/сессия не создаётся (SDK исполняет повторные вызовы executor'а
   * транзакции в ней же), commit/rollback остаётся у владельца транзакции.
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

    // Внутренний контекст нужен только для многоуровневых путей с явным
    // { trx }: одноуровневая eager-load и ambient-режим ведут себя как раньше.
    if (options?.trx && segments.length > 1) {
      await runWithTransactionContext(
        {
          trx: options.trx,
          // Executor БД, открывший транзакцию: для детекции вложенности по
          // ссылке (#98). Базовый executor сущности и есть этот db в wiring.
          db: this.executor ?? options.trx,
          ambient: true,
        },
        () => this.loadRelationSegments(rel, items, segments, options),
      );
      return;
    }

    await this.loadRelationSegments(rel, items, segments, options);
  }

  /** Тело обхода пути без управления транзакционным контекстом (#16). */
  private async loadRelationSegments(
    rel: RelationMetadata,
    items: YdbBaseEntity[],
    segments: string[],
    options?: QueryOptions,
  ): Promise<void> {
    const isIntermediate = segments.length > 1;
    const targets = await this.loadRelation(items, rel, options, {
      afterFind: !isIntermediate,
    });

    if (isIntermediate) {
      // Дети этого уровня уже загружены — пост-порядковый afterFind
      // срабатывает для этого уровня после его потомков.
      await this.loadRelationPath(targets, segments.slice(1), options);
      await this.fireAfterFindOn(targets, options);
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

      const byFk = new Map<string, YdbBaseEntity[]>();
      for (const child of children) {
        const fk = (child as any)[joinColumnName];
        const group = byFk.get(relationKey(fk));
        if (group) {
          group.push(child);
        } else {
          byFk.set(relationKey(fk), [child]);
        }
      }

      // Копия массива на инстанс: два инстанса с одним PK не должны
      // разделять один массив (раньше у каждого был свой findAll).
      for (const item of items) {
        const group = byFk.get(relationKey((item as any)[pkField]));
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
        const group = related.get(relationKey((item as any)[pkField]));
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

    const byPk = new Map<string, YdbBaseEntity>();
    for (const parent of parents) {
      byPk.set(relationKey((parent as any)[targetPk]), parent);
    }

    for (const item of items) {
      (item as any)[rel.propertyKey] =
        byPk.get(relationKey((item as any)[joinColumnName])) ?? null;
    }
    return parents;
  }

  /**
   * Пост-порядковый afterFind для инстансов промежуточного уровня
   * вложенного eager-пути (#16): срабатывает после их детей.
   *
   * Persistence создаётся с тем же { trx }, что и загрузка связи (#16-fix):
   * отложенный afterFind промежуточного уровня не теряет транзакцию
   * вызывающего — любые DB-операции внутри хуков идут через неё.
   */
  private async fireAfterFindOn(
    targets: YdbBaseEntity[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!targets.length) return;
    const Target = targets[0].constructor as typeof YdbBaseEntity;
    const targetPersistence = this.createTargetPersistence(
      Target,
      options?.trx,
    );
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
            `via @OneToMany/@ManyToOne/@OneToOne/@ManyToMany.`,
        );
      }

      await this.loadRelation(items, rel, options, { afterFind: true }, true);
    }
  }

  private async executeQuery(
    query: YdbQuery,
    options?: QueryOptions,
  ): Promise<any[][]> {
    return executeYdbQuery<any[][]>(query, options);
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
