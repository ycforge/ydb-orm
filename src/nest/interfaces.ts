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
  /**
   * Имя конфигурации (#199): позволяет поднять несколько независимых
   * YDB-конфигураций в одном процессе (по одному экземпляру на имя).
   * По умолчанию 'default' — прежнее поведение одиночной конфигурации.
   * Именованные конфигурации получают собственные DI-токены, а их сущности
   * подключаются через YdbOrmModule.forFeature(entities, name).
   */
  name?: string;
  useFactory?: (...args: any[]) => Promise<YdbModuleOptions> | YdbModuleOptions;
  inject?: any[];
  useClass?: Type<YdbOptionsFactory>;
  useExisting?: Type<YdbOptionsFactory>;
}
