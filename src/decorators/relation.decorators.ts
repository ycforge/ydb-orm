import 'reflect-metadata';
import { YdbBaseEntity } from '../entity/base-entity.js';

export const YDB_RELATIONS_KEY = 'ydb:relations';

export type RelationType = 'one-to-many' | 'many-to-one' | 'one-to-one';

export interface RelationMetadata {
  propertyKey: string;
  type: RelationType;
  target: () => typeof YdbBaseEntity;
  joinColumn: string | ((target: any) => any);
}

/**
 * Фабрика relation-декораторов.
 * Метаданные клонируются перед изменением (copy-on-write), чтобы
 * наследники не портили метаданные родительского класса.
 */
function createRelationDecorator(type: RelationType) {
  return (
    target: () => typeof YdbBaseEntity,
    joinColumn: string | ((target: any) => any),
  ): PropertyDecorator => {
    return (prototype, propertyKey) => {
      const constructor = prototype.constructor;
      const inherited: RelationMetadata[] =
        Reflect.getMetadata(YDB_RELATIONS_KEY, constructor) || [];
      const relations: RelationMetadata[] = [
        ...inherited,
        { propertyKey: propertyKey as string, type, target, joinColumn },
      ];
      Reflect.defineMetadata(YDB_RELATIONS_KEY, relations, constructor);
    };
  };
}

export const OneToMany = createRelationDecorator('one-to-many');
export const ManyToOne = createRelationDecorator('many-to-one');
export const OneToOne = createRelationDecorator('one-to-one');

export function getYdbRelationsMetadata(target: any): RelationMetadata[] {
  return Reflect.getMetadata(YDB_RELATIONS_KEY, target) || [];
}
