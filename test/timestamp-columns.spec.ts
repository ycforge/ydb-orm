import 'reflect-metadata';
import { Timestamp } from '@ydbjs/value/primitive';
import { createMockExecutor } from './helpers/mock-executor.js';
import {
  TimestampEntity,
  CreateOnlyEntity,
} from './fixtures/timestamp/timestamp.entity.js';

describe('YdbCreateDateColumn / YdbUpdateDateColumn', () => {
  afterEach(() => {
    TimestampEntity.setExecutor(undefined as any);
    CreateOnlyEntity.setExecutor(undefined as any);
  });

  describe('insert (save без uuid)', () => {
    it('устанавливает created_at и updated_at', async () => {
      const mock = createMockExecutor([[]]);
      TimestampEntity.setExecutor(mock.executor);

      const entity = new TimestampEntity();
      entity.name = 'test';
      await TimestampEntity.save(entity);

      const [q] = mock.queries;
      expect(q.params.created_at).toBeInstanceOf(Timestamp);
      expect(q.params.updated_at).toBeInstanceOf(Timestamp);
    });

    it('не перезаписывает заданное значение created_at', async () => {
      const mock = createMockExecutor([[]]);
      TimestampEntity.setExecutor(mock.executor);

      const fixed = new Date('2020-01-01T00:00:00Z');
      const entity = new TimestampEntity();
      entity.name = 'test';
      entity.created_at = fixed;
      await TimestampEntity.save(entity);

      const [q] = mock.queries;
      expect(q.params.created_at).toBeInstanceOf(Timestamp);
    });

    it('устанавливает created_at при наличии только create-колонки', async () => {
      const mock = createMockExecutor([[]]);
      CreateOnlyEntity.setExecutor(mock.executor);

      const entity = new CreateOnlyEntity();
      entity.name = 'test';
      await CreateOnlyEntity.save(entity);

      const [q] = mock.queries;
      expect(q.params.created_at).toBeInstanceOf(Timestamp);
    });
  });

  describe('update (save с uuid)', () => {
    it('устанавливает updated_at, не трогая created_at', async () => {
      const mock = createMockExecutor([
        [
          {
            uuid: '00000000-0000-0000-0000-000000000001',
            name: 'test',
            created_at: new Date('2020-01-01'),
            updated_at: new Date('2020-01-01'),
          },
        ],
      ]);
      TimestampEntity.setExecutor(mock.executor);

      const entity = new TimestampEntity();
      entity.uuid = '00000000-0000-0000-0000-000000000001';
      entity.name = 'updated';
      entity.created_at = new Date('2020-01-01');
      await TimestampEntity.save(entity);

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE');
      expect(q.params.updated_at).toBeInstanceOf(Timestamp);
    });
  });

  describe('insertMany', () => {
    it('устанавливает created_at и updated_at для каждой сущности', async () => {
      const mock = createMockExecutor([[]]);
      TimestampEntity.setExecutor(mock.executor);

      const e1 = new TimestampEntity();
      e1.name = 'one';
      const e2 = new TimestampEntity();
      e2.name = 'two';

      await TimestampEntity.insertMany([e1, e2]);

      const [q] = mock.queries;
      expect(q.params.created_at_0).toBeInstanceOf(Timestamp);
      expect(q.params.updated_at_0).toBeInstanceOf(Timestamp);
      expect(q.params.created_at_1).toBeInstanceOf(Timestamp);
      expect(q.params.updated_at_1).toBeInstanceOf(Timestamp);
    });

    it('не перезаписывает заданные значения', async () => {
      const mock = createMockExecutor([[]]);
      TimestampEntity.setExecutor(mock.executor);

      const fixed = new Date('2020-01-01T00:00:00Z');
      const e1 = new TimestampEntity();
      e1.name = 'one';
      e1.created_at = fixed;

      await TimestampEntity.insertMany([e1]);

      const [q] = mock.queries;
      expect(q.params.created_at_0).toBeInstanceOf(Timestamp);
      expect(q.params.updated_at_0).toBeInstanceOf(Timestamp);
    });
  });
});
