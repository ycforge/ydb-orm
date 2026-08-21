import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
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
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  @YdbEnum({ values: Object.values(Status), storage: 'Utf8' })
  status: Status | undefined;
}

@YdbEntity('test_enum_int32')
class EnumInt32Entity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Int32')
  @YdbEnum({ values: Object.values(Status), storage: 'Int32' })
  status: Status | undefined;
}

@YdbEntity('test_enum_nullable')
class EnumNullableEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
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

    it('binds Int32 enum in WHERE as ordinal index', async () => {
      const mock = createMockExecutor([[]]);
      EnumInt32Entity.setExecutor(mock.executor);

      await EnumInt32Entity.find({ status: Status.PENDING });

      const [q] = mock.queries;
      expect(q.sql).toContain('`status` = $status');
      // PENDING = index 2
      expect(rawValue(q.params.status)).toBe(2);
    });
  });

  describe('insertMany with enum', () => {
    const UUIDS = [
      '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
      '6ad91505-d4f6-4a81-ab65-9dbc68cf4ed6',
      '7ad91505-d4f6-4a81-ab65-9dbc68cf4ed7',
    ];

    it('converts Int32 enum to ordinal indices for all rows', async () => {
      const mock = createMockExecutor([[]]);
      EnumInt32Entity.setExecutor(mock.executor);

      const e1 = new EnumInt32Entity();
      e1.uuid = UUIDS[0];
      e1.status = Status.ACTIVE;
      const e2 = new EnumInt32Entity();
      e2.uuid = UUIDS[1];
      e2.status = Status.INACTIVE;
      const e3 = new EnumInt32Entity();
      e3.uuid = UUIDS[2];
      e3.status = Status.PENDING;

      await EnumInt32Entity.insertMany([e1, e2, e3]);

      expect(mock.queries).toHaveLength(1);
      const [q] = mock.queries;
      expect(q.sql).toContain('UPSERT INTO `test_enum_int32`');
      // ACTIVE = index 0, INACTIVE = index 1, PENDING = index 2
      expect(rawValue(q.params['status_0'])).toBe(0);
      expect(rawValue(q.params['status_1'])).toBe(1);
      expect(rawValue(q.params['status_2'])).toBe(2);
    });

    it('passes Utf8 enum string through for all rows', async () => {
      const mock = createMockExecutor([[]]);
      EnumUtf8Entity.setExecutor(mock.executor);

      const e1 = new EnumUtf8Entity();
      e1.uuid = UUIDS[0];
      e1.status = Status.ACTIVE;
      const e2 = new EnumUtf8Entity();
      e2.uuid = UUIDS[1];
      e2.status = Status.PENDING;

      await EnumUtf8Entity.insertMany([e1, e2]);

      expect(mock.queries).toHaveLength(1);
      const [q] = mock.queries;
      expect(q.sql).toContain('UPSERT INTO `test_enum_utf8`');
      expect(rawValue(q.params['status_0'])).toBe('active');
      expect(rawValue(q.params['status_1'])).toBe('pending');
    });

    it('throws on invalid enum value', async () => {
      const mock = createMockExecutor([[]]);
      EnumInt32Entity.setExecutor(mock.executor);

      const entity = new EnumInt32Entity();
      entity.uuid = UUIDS[0];
      (entity as any).status = 'deleted';

      await expect(EnumInt32Entity.insertMany([entity])).rejects.toThrow(
        /Invalid enum value "deleted" for field "status"/,
      );
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
