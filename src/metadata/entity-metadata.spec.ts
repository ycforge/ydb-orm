import 'reflect-metadata';
import { getYdbEntityMetadata } from './entity-metadata.js';
import { YdbEntity } from '../decorators/entity.decorator.js';
import { YdbColumn, YdbPrimaryColumn } from '../decorators/column.decorator.js';
import {
  YdbEncrypted,
  YdbSecurityAAD,
} from '../decorators/encryption.decorator.js';

@YdbEntity('test_metadata')
class TestEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;

  @YdbColumn('Int32')
  count!: number;

  @YdbEncrypted({ blindIndex: true })
  @YdbColumn('Utf8')
  secret!: string;

  @YdbEncrypted()
  @YdbColumn('Utf8')
  secret_no_blind!: string;

  @YdbSecurityAAD()
  @YdbColumn('Utf8')
  tenant_id!: string;
}

@YdbEntity('test_no_cols')
class EmptyEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

class UndecoratedEntity {}

describe('getYdbEntityMetadata', () => {
  it('returns metadata for a decorated entity', () => {
    const meta = getYdbEntityMetadata(TestEntity);
    expect(meta).toBeDefined();
    expect(meta!.tableName).toBe('test_metadata');
    expect(meta!.schema).toEqual({
      uuid: 'Uuid',
      name: 'Utf8',
      count: 'Int32',
      secret: 'Utf8',
      secret_no_blind: 'Utf8',
      tenant_id: 'Utf8',
    });
    expect(meta!.primaryKeys).toEqual(['uuid']);
  });

  it('collects encrypted fields with blind index flag', () => {
    const meta = getYdbEntityMetadata(TestEntity)!;
    expect(meta.encryptedFields).toHaveLength(2);
    expect(meta.encryptedFields).toContainEqual(
      expect.objectContaining({
        propertyKey: 'secret',
        blindIndex: true,
      }),
    );
    expect(meta.encryptedFields).toContainEqual(
      expect.objectContaining({
        propertyKey: 'secret_no_blind',
        blindIndex: true,
      }),
    );
  });

  it('collects AAD fields sorted lexicographically', () => {
    const meta = getYdbEntityMetadata(TestEntity)!;
    expect(meta.aadFields).toEqual(['tenant_id']);
  });

  it('returns metadata for entity with no encrypted fields', () => {
    const meta = getYdbEntityMetadata(EmptyEntity);
    expect(meta).toBeDefined();
    expect(meta!.encryptedFields).toEqual([]);
    expect(meta!.aadFields).toEqual([]);
  });

  it('returns undefined for an undecorated class', () => {
    const meta = getYdbEntityMetadata(UndecoratedEntity);
    expect(meta).toBeUndefined();
  });

  it('caches metadata across calls', () => {
    const meta1 = getYdbEntityMetadata(TestEntity);
    const meta2 = getYdbEntityMetadata(TestEntity);
    expect(meta1).toBe(meta2);
  });
});
