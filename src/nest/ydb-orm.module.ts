import { DynamicModule, Module, Provider } from '@nestjs/common';
import { YdbCoreModule } from './ydb-core.module.js';
import { createActiveRecordEntityProvider } from './repository-factory.js';
import type { YdbModuleAsyncOptions } from './interfaces.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getEntityRuntime } from '../entity/entity-runtime.js';
import {
  getRepositoryToken,
  getActiveRecordInitToken,
} from './repository-token.js';
import { DEFAULT_CONNECTION_NAME } from './constants.js';

@Module({})
export class YdbOrmModule {
  static forRoot(options: YdbModuleAsyncOptions): DynamicModule {
    const core = YdbCoreModule.forRootAsync(options);
    return {
      module: YdbOrmModule,
      imports: [core],
      exports: [core],
    };
  }

  /**
   * Подключает сущности к конфигурации connectionName (#199, по умолчанию
   * 'default'). Один класс сущности может принадлежать только одной
   * активной конфигурации: регистрация в чужой — ошибка при bootstrap.
   */
  static forFeature(
    entities: (typeof YdbBaseEntity)[],
    connectionName: string = DEFAULT_CONNECTION_NAME,
  ): DynamicModule {
    const arProviders: Provider[] = entities.map((entity) =>
      createActiveRecordEntityProvider(entity, connectionName),
    );
    const repositoryProviders: Provider[] = entities.map((entityClass) => ({
      provide: getRepositoryToken(entityClass as any, connectionName),
      useFactory: () => {
        const repo = getEntityRuntime(entityClass).repository;
        if (!repo) {
          throw new Error(
            `Repository for ${entityClass.name} is not initialized. ` +
              `Make sure YdbOrmModule.forFeature([${entityClass.name}]) is imported after YdbCoreModule.`,
          );
        }
        return repo;
      },
      inject: [getActiveRecordInitToken(entityClass as any, connectionName)],
    }));

    return {
      module: YdbOrmModule,
      providers: [...arProviders, ...repositoryProviders],
      exports: [...arProviders, ...repositoryProviders],
    };
  }
}
