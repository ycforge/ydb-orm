import 'reflect-metadata';

/** Metadata keys for lifecycle hooks. */
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

/**
 * Registers a method to run before an entity is inserted. If the method
 * mutates the entity, the changes are carried into the INSERT.
 *
 * @returns Method decorator function.
 */
export const BeforeInsert = createLifecycleDecorator(YDB_BEFORE_INSERT_KEY);
/** Registers a method to run after an entity has been inserted. */
export const AfterInsert = createLifecycleDecorator(YDB_AFTER_INSERT_KEY);
/** Registers a method to run before an entity is updated. */
export const BeforeUpdate = createLifecycleDecorator(YDB_BEFORE_UPDATE_KEY);
/** Registers a method to run after an entity is loaded from the DB. */
export const AfterFind = createLifecycleDecorator(YDB_AFTER_FIND_KEY);
/** Registers a method to run before an entity is removed. */
export const BeforeRemove = createLifecycleDecorator(YDB_BEFORE_REMOVE_KEY);

/**
 * The collected lifecycle hook method names for an entity.
 */
export interface LifecycleHooks {
  beforeInsert: string[];
  afterInsert: string[];
  beforeUpdate: string[];
  afterFind: string[];
  beforeRemove: string[];
}

/**
 * Returns the lifecycle hook method names registered on an entity class.
 *
 * @param target - Entity class constructor.
 * @returns Object with arrays of hook method names.
 */
export function getLifecycleHooks(target: any): LifecycleHooks {
  return {
    beforeInsert: Reflect.getMetadata(YDB_BEFORE_INSERT_KEY, target) || [],
    afterInsert: Reflect.getMetadata(YDB_AFTER_INSERT_KEY, target) || [],
    beforeUpdate: Reflect.getMetadata(YDB_BEFORE_UPDATE_KEY, target) || [],
    afterFind: Reflect.getMetadata(YDB_AFTER_FIND_KEY, target) || [],
    beforeRemove: Reflect.getMetadata(YDB_BEFORE_REMOVE_KEY, target) || [],
  };
}
