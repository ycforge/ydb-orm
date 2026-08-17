import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbBaseEntity,
  YdbEnum,
  getYdbEnumMetadata,
} from '../src/index.js';
import { createMockExecutor } from './helpers/mock-executor.js';

/** Извлекает raw-значение из YDB-обёртки (Utf8/Int32/etc). */
function rawValue(v: unknown): unknown {
  if (v && typeof v === 'object' && 'value' in v) return (v as any).value;
  return v;
}

enum Status {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  PENDING = 'pending',
}

@YdbEntity('test_enum_utf8')
class EnumUtf8Entity extends YdbBaseEntity {
  @YdbColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  @YdbEnum({ values: Object.values(Status), storage: 'Utf8' })
  status: Status | undefined;
}

@YdbEntity('test_enum_int32')
class EnumInt32Entity extends YdbBaseEntity {
  @YdbColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Int32')
  @YdbEnum({ values: Object.values(Status), storage: 'Int32' })
  status: Status | undefined;
}

@YdbEntity('test_enum_nullable')
class EnumNullableEntity extends YdbBaseEntity {
  @YdbColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  @YdbEnum({ values: Object.values(Status), storage: 'Utf8' })
  status: Status | undefined;
}

describe('@YdbEnum', () => {
  afterEach(() => {
    EnumUtf8Entity.setExecutor(undefined as any);
    EnumInt32Entity.setExecutor(undefined as any);
    EnumNullableEntity.setExecutor(undefined as any);
  });

  describe('Utf8 storage', () => {
    it('passes string value through on save', async () => {
      const mock = createMockExecutor([[]]);
      EnumUtf8Entity.setExecutor(mock.executor);

      const entity = new EnumUtf8Entity();
      entity.status = Status.ACTIVE;
      await EnumUtf8Entity.save(entity);

      const [q] = mock.queries;
      expect(q.sql).toContain('UPSERT INTO `test_enum_utf8`');
      expect(rawValue(q.params.status)).toBe('active');
    });

    it('converts string back on read', async () => {
      const mock = createMockExecutor([
        [{ uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5', status: 'active' }],
      ]);
      EnumUtf8Entity.setExecutor(mock.executor);

      const entity = await EnumUtf8Entity.find({
        uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
      });
      expect(entity?.status).toBe('active');
    });

    it('throws on invalid enum value on save', async () => {
      const mock = createMockExecutor([[]]);
      EnumUtf8Entity.setExecutor(mock.executor);

      const entity = new EnumUtf8Entity();
      (entity as any).status = 'invalid_value';

      await expect(EnumUtf8Entity.save(entity)).rejects.toThrow(
        /Invalid enum value "invalid_value" for field "status"/,
      );
    });
  });

  describe('Int32 storage', () => {
    it('converts string to ordinal index on save', async () => {
      const mock = createMockExecutor([[]]);
      EnumInt32Entity.setExecutor(mock.executor);

      const entity = new EnumInt32Entity();
      entity.status = Status.INACTIVE;
      await EnumInt32Entity.save(entity);

      const [q] = mock.queries;
      expect(q.sql).toContain('UPSERT INTO `test_enum_int32`');
      // INACTIVE = index 1
      expect(rawValue(q.params.status)).toBe(1);
    });

    it('converts ordinal index back to string on read', async () => {
      const mock = createMockExecutor([
        [{ uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5', status: 2 }], // PENDING = index 2
      ]);
      EnumInt32Entity.setExecutor(mock.executor);

      const entity = await EnumInt32Entity.find({
        uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
      });
      expect(entity?.status).toBe('pending');
    });

    it('converts first enum value to 0 on save', async () => {
      const mock = createMockExecutor([[]]);
      EnumInt32Entity.setExecutor(mock.executor);

      const entity = new EnumInt32Entity();
      entity.status = Status.ACTIVE;
      await EnumInt32Entity.save(entity);

      const [q] = mock.queries;
      // ACTIVE = index 0
      expect(rawValue(q.params.status)).toBe(0);
    });

    it('throws on invalid enum value on save', async () => {
      const mock = createMockExecutor([[]]);
      EnumInt32Entity.setExecutor(mock.executor);

      const entity = new EnumInt32Entity();
      (entity as any).status = 'deleted';

      await expect(EnumInt32Entity.save(entity)).rejects.toThrow(
        /Invalid enum value "deleted" for field "status"/,
      );
    });

    it('falls back to raw value for unknown index on read', async () => {
      const mock = createMockExecutor([
        [{ uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5', status: 99 }],
      ]);
      EnumInt32Entity.setExecutor(mock.executor);

      const entity = await EnumInt32Entity.find({
        uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
      });
      expect(entity?.status).toBe(99);
    });
  });

  describe('null / undefined passthrough', () => {
    it('passes null through on save', async () => {
      const mock = createMockExecutor([[]]);
      EnumNullableEntity.setExecutor(mock.executor);

      const entity = new EnumNullableEntity();
      entity.status = undefined;
      await EnumNullableEntity.save(entity);

      // status is undefined, so it's filtered out of the query
      const [q] = mock.queries;
      expect(q.sql).not.toContain('`status`');
    });

    it('converts null from DB through without error', async () => {
      const mock = createMockExecutor([
        [{ uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5', status: null }],
      ]);
      EnumNullableEntity.setExecutor(mock.executor);

      const entity = await EnumNullableEntity.find({
        uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
      });
      expect(entity?.status).toBeNull();
    });
  });

  describe('findAll with enum', () => {
    it('converts Int32 enum in multiple rows', async () => {
      const mock = createMockExecutor([
        [
          { uuid: 'u1', status: 0 },
          { uuid: 'u2', status: 2 },
        ],
      ]);
      EnumInt32Entity.setExecutor(mock.executor);

      const entities = await EnumInt32Entity.findAll();
      expect(entities).toHaveLength(2);
      expect(entities[0].status).toBe('active');
      expect(entities[1].status).toBe('pending');
    });
  });

  describe('metadata', () => {
    it('stores enum metadata correctly', () => {
      const meta = getYdbEnumMetadata(EnumUtf8Entity);
      expect(meta).toHaveLength(1);
      expect(meta[0].propertyKey).toBe('status');
      expect(meta[0].storage).toBe('Utf8');
      expect(meta[0].values).toEqual(['active', 'inactive', 'pending']);
    });

    it('returns empty array for entity without enums', () => {
      // Using YdbBaseEntity which has no enum fields
      const meta = getYdbEnumMetadata(YdbBaseEntity);
      expect(meta).toEqual([]);
    });
  });
});
