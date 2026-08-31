import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbEntityConstructor } from './ydb-repository.js';
import { YdbRepository } from './ydb-repository.js';
import { getOrCreateRepository } from './repository-resolver.js';

/**
 * Entity manager — a repository factory.
 *
 * Useful when a service needs multiple repositories or their set
 * is not known in advance. Repositories don't hold state, so
 * they can be created on the fly.
 */
export class YdbEntityManager {
  /**
   * Returns the `YdbRepository` for the given entity class, creating
   * it from the current runtime dependencies if not yet cached.
   */
  getRepository<T extends YdbBaseEntity>(
    entityClass: YdbEntityConstructor<T>,
  ): YdbRepository<T> {
    return getOrCreateRepository(entityClass);
  }
}
