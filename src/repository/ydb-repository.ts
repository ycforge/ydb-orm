import type { QueryOptions } from '../core/query-options.js';
import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbQueryBuilder } from '../query/query-builder.js';
import type {
  YdbEntityPersistence,
  YdbEntityConstructor,
} from '../persistence/entity-persistence.js';
import type { YdbEntityRelations } from '../relations/entity-relations.js';

export type { YdbEntityConstructor };

/**
 * Репозиторий для работы с конкретной сущностью YDB.
 *
 * Содержит `YdbEntityPersistence` (CRUD, шифрование, lifecycle hooks)
 * и `YdbEntityRelations` (eager/lazy relations). Является публичным DI-API:
 * `YdbOrmModule.forFeature([...])` регистрирует инжектируемый `YdbRepository<Entity>`.
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
  constructor(
    public readonly entityClass: YdbEntityConstructor<T>,
    public readonly persistence: YdbEntityPersistence<T>,
    public readonly relations: YdbEntityRelations<T>,
  ) {}

  find(where: Record<string, any>, options?: QueryOptions): Promise<T | null> {
    return this.persistence.find(where, options);
  }

  findOneBy(
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return this.persistence.findOneBy(where, options);
  }

  findAll(where?: Record<string, any>, options?: QueryOptions): Promise<T[]> {
    return this.persistence.findAll(where ?? {}, options);
  }

  findBy(where: Record<string, any>, options?: QueryOptions): Promise<T[]> {
    return this.persistence.findBy(where, options);
  }

  count(where?: Record<string, any>, options?: QueryOptions): Promise<number> {
    return this.persistence.count(where ?? {}, options);
  }

  query(): YdbQueryBuilder<T> {
    return this.persistence.query();
  }

  insertMany(entities: T[], options?: QueryOptions): Promise<T[]> {
    return this.persistence.insertMany(entities, options);
  }

  save(entity: T, options?: QueryOptions): Promise<T> {
    return this.persistence.save(entity, options);
  }

  delete(
    pkValue: string | number | Record<string, any>,
    options?: QueryOptions,
  ): Promise<T | null> {
    return this.persistence.delete(pkValue, options);
  }

  deleteBy(
    where: Record<string, any>,
    options?: QueryOptions,
  ): Promise<number> {
    return this.persistence.deleteBy(where, options);
  }

  updateBy(
    where: Record<string, any>,
    patch: Partial<Record<string, any>>,
    options?: QueryOptions,
  ): Promise<number> {
    return this.persistence.updateBy(where, patch, options);
  }

  loadRelations(
    items: T[],
    relationNames: string[],
    options?: QueryOptions,
  ): Promise<void> {
    return this.relations.loadRelations(items, relationNames, options);
  }
}
