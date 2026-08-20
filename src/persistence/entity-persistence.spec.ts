import 'reflect-metadata';
import { YdbEntity } from '../decorators/entity.decorator.js';
import { YdbColumn, YdbPrimaryColumn } from '../decorators/column.decorator.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { YdbEntityPersistence } from './entity-persistence.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';

@YdbEntity('persistence_no_pk')
class NoPkEntity extends YdbBaseEntity {
  @YdbColumn('Utf8')
  name: string;
}

@YdbEntity('persistence_pk')
class PkEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;
}

const meta = (entity: new (...args: any[]) => any) => {
  const m = getYdbEntityMetadata(entity);
  if (!m) throw new Error('no metadata');
  return m;
};

describe('YdbEntityPersistence.getPkFields', () => {
  it('throws when entity has no primary key', () => {
    const persistence = new YdbEntityPersistence(NoPkEntity, undefined);
    expect(() => persistence.getPkFields(meta(NoPkEntity))).toThrow(
      /Entity NoPkEntity must declare at least one primary key via @YdbPrimaryColumn/,
    );
  });

  it('returns declared primary keys', () => {
    const persistence = new YdbEntityPersistence(PkEntity, undefined);
    expect(persistence.getPkFields(meta(PkEntity))).toEqual(['uuid']);
  });
});
