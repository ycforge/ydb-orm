import 'reflect-metadata';
import { JsonDocEntity } from './fixtures/json_doc/json-doc.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { Utf8, Json, JsonDocument } from '@ydbjs/value/primitive';

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
      expect(q.params.metadata).toBeInstanceOf(Utf8);
      expect((q.params.metadata as any).value).toBe('{"updated":true}');
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
      expect(q.sql).toContain('WHERE `metadata` = $metadata');
      expect(q.params.metadata).toBeInstanceOf(Utf8);
      expect((q.params.metadata as any).value).toBe(JSON.stringify(metadata));
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
      expect(q.sql).toContain(
        'JSON_EXISTS(`metadata`, $metadata_0_jsonexists)',
      );
      expect(q.params.metadata_0_jsonexists).toBeInstanceOf(Utf8);
      expect((q.params.metadata_0_jsonexists as any).value).toBe(
        '$.settings.theme',
      );
    });

    it('generates JSON_VALUE condition', async () => {
      const mock = createMockExecutor([[]]);
      JsonDocEntity.setExecutor(mock.executor);

      await JsonDocEntity.query()
        .andWhereJsonValue('metadata', '$.role', 'admin')
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'JSON_VALUE(`metadata`, $metadata_0_jsonvalue_path) = $metadata_0_jsonvalue_val',
      );
      expect((q.params.metadata_0_jsonvalue_path as any).value).toBe('$.role');
      expect((q.params.metadata_0_jsonvalue_val as any).value).toBe('admin');
    });
  });
});
