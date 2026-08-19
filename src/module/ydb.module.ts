import { DynamicModule, Module, Provider } from '@nestjs/common';
import { YdbCoreModule } from './ydb-core.module.js';
import { createActiveRecordEntityProvider } from './repository-factory.js';
import { YdbModuleAsyncOptions } from '../core/interfaces.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getRepositoryToken, YdbRepository } from '../repository/index.js';

@Module({})
export class YdbModule {
  static forRoot(options: YdbModuleAsyncOptions): DynamicModule {
    const core = YdbCoreModule.forRootAsync(options);
    return {
      module: YdbModule,
      imports: [core],
      exports: [core],
    };
  }

  static forFeature(entities: (typeof YdbBaseEntity)[]): DynamicModule {
    const arProviders: Provider[] = entities.map(
      createActiveRecordEntityProvider,
    );
    const repositoryProviders: Provider[] = entities.map((entityClass) => ({
      provide: getRepositoryToken(entityClass as any),
      useFactory: () => new YdbRepository(entityClass),
    }));

    return {
      module: YdbModule,
      providers: [...arProviders, ...repositoryProviders],
      exports: [...arProviders, ...repositoryProviders],
    };
  }
}
