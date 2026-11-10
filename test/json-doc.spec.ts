import 'reflect-metadata';
import { JsonDocEntity } from './fixtures/json_doc/json-doc.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { Utf8, Json, JsonDocument, Uuid } from '@ydbjs/value/primitive';

const uuid = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';
const metadata = { role: 'admin', settings: { theme: 'dark' } };
const payload = { items: [1, 2, 3] };
const document = { title: 'doc' };

describe('JSON columns', () => {
  afterEach(() => {
    JsonDocEntity.setExecutor(undefined as any);
  });

  describe('insert', () => {
    it('serializes JSON values before binding', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      const entity = new JsonDocEntity();
      entity.metadata = metadata;
      entity.payload = payload;
      entity.document = document;

      await JsonDocEntity.save(entity);

      const [q] = mock.queries;
      expect(q.sql).toContain('UPSERT INTO `json_doc_test`');
      expect(q.params.metadata).toBeInstanceOf(Utf8);
      expect((q.params.metadata as any).value).toBe(JSON.stringify(metadata));
      expect(q.params.payload).toBeInstanceOf(Json);
      expect((q.params.payload as any).value).toBe(JSON.stringify(payload));
      expect(q.params.document).toBeInstanceOf(JsonDocument);
      expect((q.params.document as any).value).toBe(JSON.stringify(document));
    });
  });

  describe('find', () => {
    it('parses JSON values from row', async () => {
      const mock = createMockExecutor([
        [
          {
            uuid,
            metadata: JSON.stringify(metadata),
            payload,
            document,
          },
        ],
      ]);
      JsonDocEntity.setExecutor(mock.executor);

      const entity = await JsonDocEntity.find({ uuid });

      expect(entity).not.toBeNull();
      expect(entity!.metadata).toEqual(metadata);
      expect(entity!.payload).toEqual(payload);
      expect(entity!.document).toEqual(document);
    });

    it('parses native Json/JsonDocument if driver returns strings', async () => {
      const mock = createMockExecutor([
        [
          {
            uuid,
            metadata: JSON.stringify(metadata),
            payload: JSON.stringify(payload),
            document: JSON.stringify(document),
          },
        ],
      ]);
      JsonDocEntity.setExecutor(mock.executor);

      const entity = await JsonDocEntity.find({ uuid });

      expect(entity!.payload).toEqual(payload);
      expect(entity!.document).toEqual(document);
    });
  });

  describe('updateBy', () => {
    it('serializes JSON values in patch', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.updateBy({ uuid }, { metadata: { updated: true } });

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `json_doc_test`');
      expect(q.sql).toContain('`metadata` = $s0');
      expect(q.params.s0).toBeInstanceOf(Utf8);
      expect((q.params.s0 as any).value).toBe('{"updated":true}');
    });
  });

  describe('insertMany', () => {
    it('serializes JSON values for batch insert', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      const entity = new JsonDocEntity();
      entity.uuid = uuid;
      entity.metadata = metadata;
      entity.payload = payload;
      entity.document = document;

      await JsonDocEntity.insertMany([entity]);

      const [q] = mock.queries;
      expect(q.sql).toContain('UPSERT INTO `json_doc_test`');
      expect(q.params.metadata_0).toBeInstanceOf(Utf8);
      expect((q.params.metadata_0 as any).value).toBe(JSON.stringify(metadata));
      expect(q.params.payload_0).toBeInstanceOf(Json);
      expect((q.params.payload_0 as any).value).toBe(JSON.stringify(payload));
    });
  });

  describe('WHERE equality', () => {
    it('serializes object value for JSON column equality', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.find({ metadata });

      const [q] = mock.queries;
      expect(q.sql).toContain('WHERE `metadata` = $w0');
      expect(q.params.w0).toBeInstanceOf(Utf8);
      expect((q.params.w0 as any).value).toBe(JSON.stringify(metadata));
    });
  });

  describe('JSON operators', () => {
    it('generates JSON_EXISTS condition', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonExists('metadata', '$.settings.theme')
        .getMany();

      const [q] = mock.queries;
      // YQL over YDB compiles the JsonPath position as a string literal only
      // (a parameter there is a compile error), so the path is interpolated
      // as a validated literal; none of the predicate operands are parameters.
      expect(q.sql).toContain('JSON_EXISTS(`metadata`, "$.settings.theme")');
      expect(Object.keys(q.params)).toHaveLength(0);
    });

    it('generates JSON_VALUE condition', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('metadata', '$.role', 'admin')
        .getMany();

      const [q] = mock.queries;
      // Only the "equals" operand remains a parameter; the validated path is a
      // quoted literal.
      expect(q.sql).toContain('JSON_VALUE(`metadata`, "$.role") = $w0');
      expect((q.params.w0 as any).value).toBe('admin');
    });

    it('binds JSON_VALUE operand as Utf8 for Utf8 + @YdbJson (#235)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('metadata', '$.role', 'admin')
        .getMany();

      const [q] = mock.queries;
      expect(q.params.w0).toBeInstanceOf(Utf8);
      expect((q.params.w0 as any).value).toBe('admin');
    });

    it('binds JSON_VALUE operand as Utf8 for native Json (#235)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('payload', '$.items[0]', '1')
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain('JSON_VALUE(`payload`, "$.items[0]") = $w0');
      expect(q.params.w0).toBeInstanceOf(Utf8);
      expect(q.params.w0).not.toBeInstanceOf(Json);
      expect((q.params.w0 as any).value).toBe('1');
    });

    it('binds JSON_VALUE operand as Utf8 for native JsonDocument (#235)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('document', '$.title', 'doc')
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain('JSON_VALUE(`document`, "$.title") = $w0');
      expect(q.params.w0).toBeInstanceOf(Utf8);
      expect(q.params.w0).not.toBeInstanceOf(JsonDocument);
      expect((q.params.w0 as any).value).toBe('doc');
    });

    it('rejects JsonPath filter payloads (injection hardening)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      // JsonPath is interpolated as a validated string literal — a payload
      // must never be able to append YQL or JsonPath filters/functions.
      const hostile = [
        '$.a") OR 1=1 --',
        '$.a[?(@.b like_regex "([a-z]+){5}$")]',
        '$.a.keyvalue()',
        '$..a',
        '$.a both',
        '$.a";',
      ];
      for (const path of hostile) {
        await expect(
          JsonDocEntity.query().andWhereJsonExists('metadata', path).getMany(),
        ).rejects.toThrow(/invalid JsonPath/);
      }

      expect(mock.queries).toHaveLength(0);
    });

    it('accepts canonical JsonPath segments (whitelist grammar)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonExists('metadata', '$.a')
        .andWhereJsonExists('metadata', '$[0]')
        .andWhereJsonExists('metadata', '$[*]')
        .andWhereJsonExists('metadata', '$.*')
        .andWhereJsonExists('metadata', '$.a.b.c[1][*].d')
        .getMany();

      const sql = mock.queries[0].sql;
      expect(sql).toContain('JSON_EXISTS(`metadata`, "$.a")');
      expect(sql).toContain('JSON_EXISTS(`metadata`, "$[0]")');
      expect(sql).toContain('JSON_EXISTS(`metadata`, "$[*]")');
      expect(sql).toContain('JSON_EXISTS(`metadata`, "$.*")');
      expect(sql).toContain('JSON_EXISTS(`metadata`, "$.a.b.c[1][*].d")');
    });

    it('composes three JSON_EXISTS on the same column with AND (#201)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonExists('metadata', '$.settings.theme')
        .andWhereJsonExists('metadata', '$.security.role')
        .andWhereJsonExists('metadata', '$.owner.id')
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'WHERE (JSON_EXISTS(`metadata`, "$.settings.theme") ' +
          'AND JSON_EXISTS(`metadata`, "$.security.role") ' +
          'AND JSON_EXISTS(`metadata`, "$.owner.id"))',
      );
      expect(Object.keys(q.params)).toHaveLength(0);
    });

    it('composes mixed JSON_EXISTS + JSON_VALUE on the same column (#201)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonExists('metadata', '$.settings.theme')
        .andWhereJsonValue('metadata', '$.role', 'admin')
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'WHERE (JSON_EXISTS(`metadata`, "$.settings.theme") ' +
          'AND JSON_VALUE(`metadata`, "$.role") ' +
          '= $w0)',
      );
      expect((q.params.w0 as any).value).toBe('admin');
    });

    it('composes two JSON_VALUE on the same column with AND (#201)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('metadata', '$.role', 'admin')
        .andWhereJsonValue('metadata', '$.theme', 'dark')
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'WHERE (JSON_VALUE(`metadata`, "$.role") ' +
          '= $w0 ' +
          'AND JSON_VALUE(`metadata`, "$.theme") ' +
          '= $w1)',
      );
      expect((q.params.w0 as any).value).toBe('admin');
      expect((q.params.w1 as any).value).toBe('dark');
    });

    it('composes JSON predicates with ordinary where/andWhere criteria (#201)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .where({ uuid })
        .andWhereJsonExists('metadata', '$.settings.theme')
        .andWhereJsonValue('metadata', '$.role', 'admin')
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'WHERE `uuid` = $w0 AND (JSON_EXISTS(`metadata`, "$.settings.theme") ' +
          'AND JSON_VALUE(`metadata`, "$.role") ' +
          '= $w1)',
      );
      expect(q.params.w0).toBeInstanceOf(Uuid);
      expect(String(q.params.w0)).toBe(uuid);
    });

    it('keeps JSON predicates intact inside an $or group (#201)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('metadata', '$.role', 'admin')
        .orWhere({ uuid })
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'WHERE (JSON_VALUE(`metadata`, "$.role") = $w0 OR `uuid` = $w1)',
      );
      expect((q.params.w0 as any).value).toBe('admin');
      expect(q.params.w1).toBeInstanceOf(Uuid);
      expect(String(q.params.w1)).toBe(uuid);
    });

    it('builds composed JSON predicates from a hand-written $and object (#201)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.find({
        metadata: {
          $and: [
            { $jsonExists: '$.settings.theme' },
            { $jsonValue: { path: '$.role', equals: 'admin' } },
          ],
        },
      });

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'WHERE (JSON_EXISTS(`metadata`, "$.settings.theme") ' +
          'AND JSON_VALUE(`metadata`, "$.role") ' +
          '= $w0)',
      );
    });
  });
});
