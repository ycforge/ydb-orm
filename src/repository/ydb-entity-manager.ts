import type { YdbBaseEntity } from '../entity/base-entity.js';
import { YdbRepository, type YdbEntityConstructor } from './ydb-repository.js';

/**
 * Менеджер сущностей — фабрика репозиториев.
 *
 * Удобен, когда сервису нужны несколько репозиториев или их набор
 * заранее неизвестен. Репозитории не хранят состояния, поэтому
 * можно создавать их на лету.
 */
export class YdbEntityManager {
  getRepository<T extends YdbBaseEntity>(
    entityClass: YdbEntityConstructor<T>,
  ): YdbRepository<T> {
    return new YdbRepository<T>(entityClass);
  }
}
