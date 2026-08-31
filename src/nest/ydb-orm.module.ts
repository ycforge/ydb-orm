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
  /**
   * Registers the core YDB module (driver/executor/credentials) and
   * re-exports it, so one YdbOrmModule.forRoot(...) import in the root
   * module is enough for the whole application.
   */
  static forRoot(options: YdbModuleAsyncOptions): DynamicModule {
    const core = YdbCoreModule.forRootAsync(options);
    return {
      module: YdbOrmModule,
      imports: [core],
      exports: [core],
    };
  }

  /**
   * Attaches entities to the connectionName configuration (#199, defaults
   * to 'default'). An entity class can belong to only one active
   * configuration: registering it in a foreign one fails at bootstrap.
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
