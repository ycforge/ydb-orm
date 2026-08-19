import type { QueryOptions } from '../core/query-options.js';
import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbQueryBuilder } from '../query/query-builder.js';

/**
 * Тип сущности-конструктора, совместимого с YdbBaseEntity.
 */
export type YdbEntityConstructor<T extends YdbBaseEntity> = {
  new (): T;
} & typeof YdbBaseEntity;

/**
 * Репозиторий для работы с конкретной сущностью YDB.
 *
 * Представляет собой DI-чистую обёртку над статическими методами
 * Active Record (YdbBaseEntity). Все вызовы делегируют в `EntityClass`,
 * поэтому рантайм-зависимости (executor, encryption/validation providers)
 * по-прежнему настраиваются один раз через `YdbModule.forFeature([...])`
 * или `configureEntities([...])`.
 *
 * Использование в NestJS:
 * ```ts
 * @Injectable()
 * class UserService {
 *   constructor(
 *     @InjectRepository(User) private repo: YdbRepository<User>,
 *   ) {}
 *
 *   async findByEmail(email: string) {
 *     return this.repo.findOneBy({ email });
 *   }
 * }
 * ```
 */
export class YdbRepository<T extends YdbBaseEntity> {
  constructor(public readonly entityClass: YdbEntityConstructor<T>) {}

  find(where: Record<string, any>, options?: QueryOptions): Promise<T | null> {
    return this.entityClass.find<T>(where, options);
  }

  findOneBy(
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return this.entityClass.findOneBy<T>(where, options);
  }

  findAll(where?: Record<string, any>, options?: QueryOptions): Promise<T[]> {
    return this.entityClass.findAll<T>(where ?? {}, options);
  }

  findBy(where: Record<string, any>, options?: QueryOptions): Promise<T[]> {
    return this.entityClass.findBy<T>(where, options);
  }

  count(where?: Record<string, any>, options?: QueryOptions): Promise<number> {
    return this.entityClass.count(where ?? {}, options);
  }

  query(): YdbQueryBuilder<T> {
    return this.entityClass.query<T>();
  }

  insertMany(entities: T[], options?: QueryOptions): Promise<T[]> {
    return this.entityClass.insertMany<T>(entities, options);
  }

  save(entity: T, options?: QueryOptions): Promise<T> {
    return this.entityClass.save<T>(entity, options);
  }

  delete(pkValue: string | number, options?: QueryOptions): Promise<T | null> {
    return this.entityClass.delete<T>(pkValue, options);
  }

  deleteBy(
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<number> {
    return this.entityClass.deleteBy(where, options);
  }
}
