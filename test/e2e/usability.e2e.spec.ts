import 'reflect-metadata';
import { beforeAll, afterAll, describe, it, expect } from '@jest/globals';
import { create } from '@bufbuild/protobuf';
import {
  TableServiceDefinition,
  DescribeTableResponseSchema,
} from '@ydbjs/api/table';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';
import type { Driver } from '@ydbjs/core';
import {
  YdbBaseEntity,
  YdbEntity,
  YdbPrimaryColumn,
  YdbColumn,
  YdbJson,
  YdbCreateDateColumn,
  YdbUpdateDateColumn,
  YdbSchemaSyncer,
  createExecutor,
  rawJson,
} from '../../src/index.js';
import {
  createE2eContext,
  hasYdbCredentials,
  type E2eContext,
} from './setup.js';

const table = `usability_${Date.now()}`;
@YdbEntity(table)
class Entry extends YdbBaseEntity {
  @YdbPrimaryColumn('Int32') id!: number;
  @YdbColumn('Json') payload!: unknown;
  @YdbColumn('JsonDocument') document!: unknown;
  @YdbJson() @YdbColumn('Utf8') metadata!: unknown;
  @YdbCreateDateColumn() createdAt!: Date;
  @YdbUpdateDateColumn() updatedAt!: Date;
}
const suite = hasYdbCredentials() ? describe : describe.skip;
suite('serverless usability against YDB', () => {
  let ctx: E2eContext;
  let syncer: YdbSchemaSyncer;
  beforeAll(async () => {
    ctx = (await createE2eContext())!;
    const executor = createExecutor(ctx.driver, { endpoint: 'unused' });
    Entry.setExecutor(executor);
    let simulated = false;
    // Reproduce the serverless Table response while using the real Scheme API
    // to distinguish an absent path from an existing/protected object.
    const original = ctx.driver.createClient.bind(ctx.driver);
    const driver = {
      database: ctx.driver.database,
      createClient(service: unknown) {
        const client = original(service as never);
        if (service !== TableServiceDefinition) return client;
        return new Proxy(client, {
          get(target, property) {
            if (property === 'describeTable' && !simulated)
              return () => {
                simulated = true;
                return Promise.resolve(
                  create(DescribeTableResponseSchema, {
                    operation: { status: StatusIds_StatusCode.SCHEME_ERROR },
                  }),
                );
              };
            return Reflect.get(target, property);
          },
        });
      },
    } as unknown as Driver;
    syncer = new YdbSchemaSyncer(driver, executor);
    await syncer.sync([Entry]);
    expect(simulated).toBe(true);
  }, 60000);
  afterAll(async () => {
    if (!ctx) return;
    try {
      await ctx.executor([
        `DROP TABLE IF EXISTS \`${table}\``,
      ] as unknown as TemplateStringsArray);
    } finally {
      ctx.driver.close();
    }
  }, 30000);

  it('creates the missing table and standalone timestamp columns', async () => {
    const schema = await syncer.describeTable(table);
    expect([...(schema?.columns.keys() ?? [])]).toEqual(
      expect.arrayContaining(['createdAt', 'updatedAt']),
    );
  });

  it('round-trips strings, objects and explicit raw JSON without double decoding', async () => {
    const values = [
      'hello',
      '123',
      'null',
      '{"x":1}',
      '',
      { x: 1 },
      [1, 'a'],
      rawJson('{"raw":true}'),
    ];
    await Entry.insertMany(
      values.map((value, id) =>
        Object.assign(new Entry(), {
          id,
          payload: value,
          document: value,
          metadata: value,
        }),
      ),
    );
    const rows = await Entry.findAllPaged({}, { pageSize: 3 });
    expect(rows).toHaveLength(values.length);
    rows.forEach((row, index) => {
      const expected =
        index === values.length - 1 ? { raw: true } : values[index];
      expect(row.payload).toEqual(expected);
      expect(row.document).toEqual(expected);
      expect(row.metadata).toEqual(expected);
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });
  }, 30000);

  it('does not silently truncate findAll; paged reads return more than 100 rows', async () => {
    await Entry.insertMany(
      Array.from({ length: 105 }, (_, index) =>
        Object.assign(new Entry(), { id: index + 100 }),
      ),
    );
    await expect(Entry.findAll()).rejects.toThrow('findAllPaged');
    const rows = await Entry.findAllPaged({}, { pageSize: 25 });
    expect(rows).toHaveLength(113);
    expect(new Set(rows.map((row) => row.id)).size).toBe(113);
  }, 30000);
});
