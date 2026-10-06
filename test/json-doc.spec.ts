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
      expect(q.sql).toContain('JSON_EXISTS(`metadata`, $w0)');
      expect(q.params.w0).toBeInstanceOf(Utf8);
      expect((q.params.w0 as any).value).toBe('$.settings.theme');
    });

    it('generates JSON_VALUE condition', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('metadata', '$.role', 'admin')
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain('JSON_VALUE(`metadata`, $w0) = $w1');
      expect((q.params.w0 as any).value).toBe('$.role');
      expect((q.params.w1 as any).value).toBe('admin');
    });

    it('binds JSON_VALUE operand as Utf8 for Utf8 + @YdbJson (#235)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('metadata', '$.role', 'admin')
        .getMany();

      const [q] = mock.queries;
      expect(q.params.w1).toBeInstanceOf(Utf8);
      expect((q.params.w1 as any).value).toBe('admin');
    });

    it('binds JSON_VALUE operand as Utf8 for native Json (#235)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('payload', '$.items[0]', '1')
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain('JSON_VALUE(`payload`, $w0) = $w1');
      expect(q.params.w1).toBeInstanceOf(Utf8);
      expect(q.params.w1).not.toBeInstanceOf(Json);
      expect((q.params.w1 as any).value).toBe('1');
    });

    it('binds JSON_VALUE operand as Utf8 for native JsonDocument (#235)', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('document', '$.title', 'doc')
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain('JSON_VALUE(`document`, $w0) = $w1');
      expect(q.params.w1).toBeInstanceOf(Utf8);
      expect(q.params.w1).not.toBeInstanceOf(JsonDocument);
      expect((q.params.w1 as any).value).toBe('doc');
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
        'WHERE (JSON_EXISTS(`metadata`, $w0) ' +
          'AND JSON_EXISTS(`metadata`, $w1) ' +
          'AND JSON_EXISTS(`metadata`, $w2))',
      );
      expect((q.params.w0 as any).value).toBe('$.settings.theme');
      expect((q.params.w1 as any).value).toBe('$.security.role');
      expect((q.params.w2 as any).value).toBe('$.owner.id');
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
        'WHERE (JSON_EXISTS(`metadata`, $w0) ' +
          'AND JSON_VALUE(`metadata`, $w1) ' +
          '= $w2)',
      );
      expect((q.params.w0 as any).value).toBe('$.settings.theme');
      expect((q.params.w1 as any).value).toBe('$.role');
      expect((q.params.w2 as any).value).toBe('admin');
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
        'WHERE (JSON_VALUE(`metadata`, $w0) ' +
          '= $w1 ' +
          'AND JSON_VALUE(`metadata`, $w2) ' +
          '= $w3)',
      );
      expect((q.params.w1 as any).value).toBe('admin');
      expect((q.params.w3 as any).value).toBe('dark');
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
        'WHERE `uuid` = $w0 AND (JSON_EXISTS(`metadata`, $w1) ' +
          'AND JSON_VALUE(`metadata`, $w2) ' +
          '= $w3)',
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
        'WHERE (JSON_VALUE(`metadata`, $w0) ' + '= $w1 OR `uuid` = $w2)',
      );
      expect((q.params.w1 as any).value).toBe('admin');
      expect(q.params.w2).toBeInstanceOf(Uuid);
      expect(String(q.params.w2)).toBe(uuid);
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
        'WHERE (JSON_EXISTS(`metadata`, $w0) ' +
          'AND JSON_VALUE(`metadata`, $w1) ' +
          '= $w2)',
      );
    });
  });
});
