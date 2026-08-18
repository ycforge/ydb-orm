import 'reflect-metadata';

export const YDB_BEFORE_INSERT_KEY = 'ydb:lifecycle:beforeInsert';
export const YDB_AFTER_INSERT_KEY = 'ydb:lifecycle:afterInsert';
export const YDB_BEFORE_UPDATE_KEY = 'ydb:lifecycle:beforeUpdate';
export const YDB_AFTER_FIND_KEY = 'ydb:lifecycle:afterFind';
export const YDB_BEFORE_REMOVE_KEY = 'ydb:lifecycle:beforeRemove';

function createLifecycleDecorator(metadataKey: string): MethodDecorator {
  return (_target, propertyKey) => {
    const constructor = _target.constructor;
    const existing: string[] =
      Reflect.getMetadata(metadataKey, constructor) || [];
    if (existing.includes(propertyKey as string)) return;
    Reflect.defineMetadata(
      metadataKey,
      [...existing, propertyKey as string],
      constructor,
    );
  };
}

export const BeforeInsert = createLifecycleDecorator(YDB_BEFORE_INSERT_KEY);
export const AfterInsert = createLifecycleDecorator(YDB_AFTER_INSERT_KEY);
export const BeforeUpdate = createLifecycleDecorator(YDB_BEFORE_UPDATE_KEY);
export const AfterFind = createLifecycleDecorator(YDB_AFTER_FIND_KEY);
export const BeforeRemove = createLifecycleDecorator(YDB_BEFORE_REMOVE_KEY);

export interface LifecycleHooks {
  beforeInsert: string[];
  afterInsert: string[];
  beforeUpdate: string[];
  afterFind: string[];
  beforeRemove: string[];
}

export function getLifecycleHooks(target: any): LifecycleHooks {
  return {
    beforeInsert: Reflect.getMetadata(YDB_BEFORE_INSERT_KEY, target) || [],
    afterInsert: Reflect.getMetadata(YDB_AFTER_INSERT_KEY, target) || [],
    beforeUpdate: Reflect.getMetadata(YDB_BEFORE_UPDATE_KEY, target) || [],
    afterFind: Reflect.getMetadata(YDB_AFTER_FIND_KEY, target) || [],
    beforeRemove: Reflect.getMetadata(YDB_BEFORE_REMOVE_KEY, target) || [],
  };
}
