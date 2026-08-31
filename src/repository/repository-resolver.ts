import type { YdbBaseEntity } from '../entity/base-entity.js';
import { getEntityRuntime } from '../entity/entity-runtime.js';
import type { RepositoryDepsSnapshot } from '../entity/entity-runtime.js';
import {
  YdbEntityPersistence,
  type YdbEntityConstructor,
} from '../persistence/entity-persistence.js';
import { YdbEntityRelations } from '../relations/entity-relations.js';
import { YdbRepository } from './ydb-repository.js';

export type { YdbEntityConstructor };

function buildSnapshot(
  runtime: RepositoryDepsSnapshot,
): RepositoryDepsSnapshot {
  return {
    executor: runtime.executor,
    encryptionProvider: runtime.encryptionProvider,
    blindIndexProvider: runtime.blindIndexProvider,
    validationProvider: runtime.validationProvider,
    uuidGenerator: runtime.uuidGenerator,
    aadFormat: runtime.aadFormat,
    aadReadFallback: runtime.aadReadFallback,
  };
}

function sameDeps(
  a: RepositoryDepsSnapshot | undefined,
  b: RepositoryDepsSnapshot | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.executor === b.executor &&
    a.encryptionProvider === b.encryptionProvider &&
    a.blindIndexProvider === b.blindIndexProvider &&
    a.validationProvider === b.validationProvider &&
    a.uuidGenerator === b.uuidGenerator &&
    a.aadFormat === b.aadFormat &&
    a.aadReadFallback === b.aadReadFallback
  );
}

/**
 * Returns (or creates) a YdbRepository for an entity from current runtime deps.
 * Repository is cached in entity-runtime and recreated when executor/providers change.
 */
export function getOrCreateRepository<T extends YdbBaseEntity>(
  entityClass: YdbEntityConstructor<T>,
): YdbRepository<T> {
  const runtime = getEntityRuntime(entityClass);
  const currentDeps = buildSnapshot(runtime);

  if (runtime.repository && sameDeps(runtime.repositoryDeps, currentDeps)) {
    return runtime.repository as YdbRepository<T>;
  }

  const persistence = new YdbEntityPersistence(entityClass, runtime.executor, {
    encryptionProvider: runtime.encryptionProvider,
    blindIndexProvider: runtime.blindIndexProvider,
    validationProvider: runtime.validationProvider,
    uuidGenerator: runtime.uuidGenerator,
    aadFormat: runtime.aadFormat,
    aadReadFallback: runtime.aadReadFallback,
  });

  const relations = new YdbEntityRelations(entityClass, runtime.executor, {
    encryptionProvider: runtime.encryptionProvider,
    blindIndexProvider: runtime.blindIndexProvider,
  });

  const repository = new YdbRepository(entityClass, persistence, relations);
  runtime.repository = repository;
  runtime.repositoryDeps = currentDeps;
  return repository;
}
