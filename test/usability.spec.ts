import 'reflect-metadata';
import { describe, it, expect, jest } from '@jest/globals';
import {
  YdbBaseEntity,
  YdbEntity,
  YdbPrimaryColumn,
  YdbColumn,
  YdbJson,
  YdbCreateDateColumn,
  YdbUpdateDateColumn,
  getYdbEntityMetadata,
  YdbSchemaSyncer,
  rawJson,
  serverlessYdbOptions,
} from '../src/index.js';
import { serializeJson } from '../src/core/json-value.js';
import { validatePoolOptions } from '../src/core/driver.js';
import { createMockExecutor } from './helpers/mock-executor.js';

@YdbEntity('usability_rows')
class Row extends YdbBaseEntity {
  @YdbPrimaryColumn('Int32') id!: number;
  @YdbJson() @YdbColumn('Utf8') metadata!: unknown;
  @YdbColumn('Json') payload!: unknown;
  @YdbCreateDateColumn() createdAt!: Date;
  @YdbUpdateDateColumn() updatedAt!: Date;
}

describe('serverless usability', () => {
  it('does not silently truncate an implicit findAll and allows explicit bounded reads', async () => {
    const rows = Array.from({ length: 101 }, (_, id) => ({ id }));
    const mock = createMockExecutor([rows]);
    Row.setExecutor(mock.executor);
    await expect(Row.findAll()).rejects.toThrow('findAllPaged');
    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0].sql).toContain('LIMIT 101');
    const bounded = createMockExecutor([rows.slice(0, 100)]);
    Row.setExecutor(bounded.executor);
    await expect(Row.findAll({}, { limit: 100 })).resolves.toHaveLength(100);
  });

  it('reads ordered pages beyond the old limit, retaining filters and projection', async () => {
    const mock = createMockExecutor(
      [[[{ id: 1 }, { id: 2 }]], [[{ id: 3 }, { id: 4 }]], [[{ id: 5 }]]],
      { sequential: true },
    );
    Row.setExecutor(mock.executor);
    const rows = await Row.findAllPaged(
      { id: { $gt: 0 } },
      { pageSize: 2, select: ['id'] },
    );
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(mock.queries.map((query) => query.sql)).toEqual([
      expect.stringContaining('ORDER BY `id` LIMIT 2 OFFSET 0'),
      expect.stringContaining('ORDER BY `id` LIMIT 2 OFFSET 2'),
      expect.stringContaining('ORDER BY `id` LIMIT 2 OFFSET 4'),
    ]);
    expect(
      mock.queries.every((query) => Object.keys(query.params).length === 1),
    ).toBe(true);
  });

  it('honors a total limit across pages and cancellation before starting', async () => {
    const mock = createMockExecutor([[[{ id: 1 }, { id: 2 }]], [[{ id: 3 }]]], {
      sequential: true,
    });
    Row.setExecutor(mock.executor);
    await expect(
      Row.findAllPaged({}, { pageSize: 2, limit: 3 }),
    ).resolves.toHaveLength(3);
    expect(mock.queries[1].sql).toContain('LIMIT 1 OFFSET 2');
    await expect(
      Row.findAllPaged({}, { signal: AbortSignal.abort(new Error('stop')) }),
    ).rejects.toThrow('stop');
    await expect(Row.findAllPaged({}, { pageSize: 0 })).rejects.toThrow(
      'pageSize',
    );
  });

  it('declares timestamp columns without a second decorator', () => {
    expect(getYdbEntityMetadata(Row)?.schema).toMatchObject({
      createdAt: 'Timestamp',
      updatedAt: 'Timestamp',
    });
  });

  it.each(['hello', '123', 'null', '{"x":1}', '', '"quoted"'])(
    'round-trips JSON string %j through native and Utf8 storage',
    async (value) => {
      const write = createMockExecutor([[]]);
      Row.setExecutor(write.executor);
      await Row.insertMany([
        Object.assign(new Row(), { id: 1, payload: value, metadata: value }),
      ]);
      const params = write.queries[0].params as Record<
        string,
        { value: unknown }
      >;
      expect(params.payload_0.value).toBe(JSON.stringify(value));
      expect(params.metadata_0.value).toBe(JSON.stringify(value));
      const read = createMockExecutor([
        [
          {
            id: 1,
            payload: JSON.parse(String(params.payload_0.value)),
            metadata: params.metadata_0.value,
          },
        ],
      ]);
      Row.setExecutor(read.executor);
      const row = await Row.find({ id: 1 });
      expect(row?.payload).toBe(value);
      expect(row?.metadata).toBe(value);
    },
  );

  it('requires an explicit marker for serialized JSON and rejects invalid JSON', () => {
    expect(serializeJson(rawJson('{"x":1}'))).toBe('{"x":1}');
    expect(serializeJson('{"x":1}')).toBe('"{\\"x\\":1}"');
    expect(() => rawJson('plain text')).toThrow();
    expect(() => serializeJson(undefined)).toThrow();
  });

  it('bounds cold-start DescribeTable concurrency and waits before DDL', async () => {
    const entities = Array.from({ length: 9 }, (_, index) => {
      class Child extends Row {}
      YdbEntity(`sync_concurrency_${index}`)(Child);
      return Child;
    });
    const mock = createMockExecutor([[]]);
    const syncer = new YdbSchemaSyncer({} as never, mock.executor);
    let active = 0;
    let peak = 0;
    jest.spyOn(syncer, 'describeTable').mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return null;
    });
    await syncer.sync(entities);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(mock.queries).toHaveLength(9);
  });

  it('waits for in-flight descriptions and issues no DDL after a metadata failure', async () => {
    class Other extends Row {}
    YdbEntity('sync_failure_other')(Other);
    const mock = createMockExecutor([[]]);
    const syncer = new YdbSchemaSyncer({} as never, mock.executor);
    let completed = 0;
    jest.spyOn(syncer, 'describeTable').mockImplementation(async (table) => {
      await Promise.resolve();
      completed += 1;
      if (table === 'usability_rows') throw new Error('metadata unavailable');
      return null;
    });
    await expect(syncer.sync([Row, Other])).rejects.toThrow(
      'metadata unavailable',
    );
    expect(completed).toBe(2);
    expect(mock.queries).toHaveLength(0);
  });

  it('provides a conservative overridable profile and rejects ignored SDK options', () => {
    const profile = serverlessYdbOptions({
      endpoint: 'grpc://localhost:2136/local',
      poolOptions: { maxSize: 2 },
    });
    expect(profile.sync).toBe(false);
    expect(profile.poolOptions).toEqual({
      minSize: 0,
      maxSize: 2,
      waitQueueFactor: 2,
    });
    expect(profile.driverOptions?.['ydb.sdk.ready_timeout_ms']).toBe(10000);
    expect(() => validatePoolOptions({ sessionTimeout: 10 } as never)).toThrow(
      'Unsupported poolOptions.sessionTimeout',
    );
    expect(() => validatePoolOptions({ minSize: 5, maxSize: 1 })).toThrow();
    expect(() => validatePoolOptions({ waitQueueFactor: 0 })).toThrow();
  });
});
