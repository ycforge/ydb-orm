import { ModuleMetadata, Type } from '@nestjs/common';
import type { YdbModuleOptions } from '../core/interfaces.js';

/**
 * Фабрика опций для forRootAsync() (паттерн async-модуля NestJS).
 */
export interface YdbOptionsFactory {
  createYdbOptions(): Promise<YdbModuleOptions> | YdbModuleOptions;
}

/**
 * Опции YdbOrmModule.forRootAsync() / YdbCoreModule.forRootAsync().
 * Тип специфичен для NestJS-интеграции (imports/useClass/useExisting) —
 * живёт в подпакете `@ycforge/ydb-orm/nest`.
 */
export interface YdbModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory?: (...args: any[]) => Promise<YdbModuleOptions> | YdbModuleOptions;
  inject?: any[];
  useClass?: Type<YdbOptionsFactory>;
  useExisting?: Type<YdbOptionsFactory>;
}
