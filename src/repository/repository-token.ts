import { Inject } from '@nestjs/common';
import type { YdbBaseEntity } from '../entity/base-entity.js';
import type { YdbEntityConstructor } from './ydb-repository.js';

const REPOSITORY_TOKEN_PREFIX = 'YDB_REPOSITORY_' as const;

/**
 * Возвращает DI-токен для репозитория указанной сущности.
 */
export function getRepositoryToken<T extends YdbBaseEntity>(
  entityClass: YdbEntityConstructor<T>,
): string {
  return `${REPOSITORY_TOKEN_PREFIX}${entityClass.name}`;
}

/**
 * Декоратор для инъекции репозитория сущности в NestJS-сервисы.
 *
 * ```ts
 * @Injectable()
 * class UserService {
 *   constructor(@InjectRepository(User) private repo: YdbRepository<User>) {}
 * }
 * ```
 */
export function InjectRepository<T extends YdbBaseEntity>(
  entityClass: YdbEntityConstructor<T>,
): ReturnType<typeof Inject> {
  return Inject(getRepositoryToken(entityClass));
}
