import { DynamicModule, Module, Provider } from '@nestjs/common';
import { YdbCoreModule } from './ydb-core.module.js';
import { YdbTransactionManager } from '../transaction/transaction.manager.js';
import { createActiveRecordEntityProvider } from './repository-factory.js';
import { YdbModuleAsyncOptions } from '../core/interfaces.js';
import { YdbBaseEntity } from '../entity/base-entity.js';

@Module({})
export class YdbModule {
  static forRoot(options: YdbModuleAsyncOptions): DynamicModule {
    return {
      module: YdbModule,
      imports: [YdbCoreModule.forRootAsync(options)],
      exports: [YdbTransactionManager],
    };
  }

  static forFeature(entities: (typeof YdbBaseEntity)[]): DynamicModule {
    const providers: Provider[] = entities.map(
      createActiveRecordEntityProvider,
    );

    return {
      module: YdbModule,
      providers,
      exports: providers,
    };
  }
}
