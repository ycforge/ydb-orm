import { ModuleMetadata, Type } from '@nestjs/common';
import type { YdbModuleOptions } from '../core/interfaces.js';

/**
 * Options factory for forRootAsync() (NestJS async-module pattern).
 */
export interface YdbOptionsFactory {
  createYdbOptions(): Promise<YdbModuleOptions> | YdbModuleOptions;
}

/**
 * Options for YdbOrmModule.forRootAsync() / YdbCoreModule.forRootAsync().
 * The type is specific to the NestJS integration (imports/useClass/
 * useExisting) — it lives in the `@ycforge/ydb-orm/nest` subpackage.
 */
export interface YdbModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /**
   * Configuration name (#199): allows several independent YDB
   * configurations in one process (one instance per name). Defaults to
   * 'default' — the previous single-configuration behavior. Named
   * configurations get their own DI tokens, their entities are attached
   * via YdbOrmModule.forFeature(entities, name).
   */
  name?: string;
  useFactory?: (...args: any[]) => Promise<YdbModuleOptions> | YdbModuleOptions;
  inject?: any[];
  useClass?: Type<YdbOptionsFactory>;
  useExisting?: Type<YdbOptionsFactory>;
}
