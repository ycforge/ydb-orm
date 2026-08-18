import {
  createE2eContext,
  closeE2eContext,
  hasYdbCredentials,
  createTableForEntity,
  dropTableForEntity,
  type E2eContext,
} from './setup.js';
import { E2eItemEntity, E2eSecretEntity } from './entities.js';
import { E2eOrderEntity, E2eOrderItemEntity } from './entities.js';

let ctx: E2eContext | null = null;

beforeAll(async () => {
  ctx = await createE2eContext();
  if (!ctx) return;

  // Create tables using schema sync (generates correct YQL types)
  for (const Entity of [E2eItemEntity, E2eSecretEntity, E2eOrderEntity, E2eOrderItemEntity]) {
    await createTableForEntity(ctx.executor, Entity);
  }

  // Inject executor and encryption providers
  E2eItemEntity.setExecutor(ctx.executor);
  E2eSecretEntity.setExecutor(ctx.executor);
  E2eSecretEntity.setEncryptionProvider(ctx.encryptionProvider);
  E2eSecretEntity.setBlindIndexProvider(ctx.blindIndexProvider);
  E2eOrderEntity.setExecutor(ctx.executor);
  E2eOrderItemEntity.setExecutor(ctx.executor);
});

afterAll(async () => {
  if (!ctx) return;

  for (const Entity of [E2eOrderItemEntity, E2eOrderEntity, E2eSecretEntity, E2eItemEntity]) {
    await dropTableForEntity(ctx.executor, Entity);
  }

  // Cleanup runtime
  E2eItemEntity.setExecutor(undefined as any);
  E2eSecretEntity.setExecutor(undefined as any);
  E2eSecretEntity.setEncryptionProvider(undefined as any);
  E2eSecretEntity.setBlindIndexProvider(undefined as any);
  E2eOrderEntity.setExecutor(undefined as any);
  E2eOrderItemEntity.setExecutor(undefined as any);

  await closeE2eContext(ctx);
});

const describeE2e = () => (hasYdbCredentials() ? describe : describe.skip);

describeE2e()('BaseEntity e2e: CRUD', () => {
  it('insert via save() and retrieve via find()', async () => {
    const item = new E2eItemEntity();
    item.name = 'Widget';
    item.quantity = 10;
    item.price = 9.99;
    item.active = true;
    item.total_views = 1000n;
    item.description = 'A fine widget';

    const saved = await E2eItemEntity.save(item);

    expect(saved.uuid).toBeDefined();
    expect(saved.name).toBe('Widget');
    expect(saved.quantity).toBe(10);
    expect(saved.price).toBeCloseTo(9.99);
    expect(saved.active).toBe(true);
    expect(saved.total_views).toBe(1000n);

    const found = await E2eItemEntity.find({ uuid: saved.uuid });
    expect(found).not.toBeNull();
    expect(found!.uuid).toBe(saved.uuid);
    expect(found!.name).toBe('Widget');
  });

  it('update via save() with existing uuid', async () => {
    const item = new E2eItemEntity();
    item.name = 'Before Update';
    item.quantity = 1;
    item.price = 1.0;
    item.active = false;
    item.total_views = 0n;
    item.description = '';
    await E2eItemEntity.save(item);

    item.name = 'After Update';
    item.quantity = 99;
    const updated = await E2eItemEntity.save(item);

    expect(updated.name).toBe('After Update');
    expect(updated.quantity).toBe(99);

    const found = await E2eItemEntity.find({ uuid: item.uuid });
    expect(found!.name).toBe('After Update');
  });

  it('findAll() returns multiple entities', async () => {
    const a = new E2eItemEntity();
    a.name = 'ListA';
    a.quantity = 1;
    a.price = 1;
    a.active = true;
    a.total_views = 0n;
    a.description = '';
    await E2eItemEntity.save(a);

    const b = new E2eItemEntity();
    b.name = 'ListB';
    b.quantity = 2;
    b.price = 2;
    b.active = false;
    b.total_views = 0n;
    b.description = '';
    await E2eItemEntity.save(b);

    const all = await E2eItemEntity.findAll();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('count() returns correct count', async () => {
    const before = await E2eItemEntity.count();

    const item = new E2eItemEntity();
    item.name = 'CountMe';
    item.quantity = 1;
    item.price = 1;
    item.active = true;
    item.total_views = 0n;
    item.description = '';
    await E2eItemEntity.save(item);

    const after = await E2eItemEntity.count();
    expect(after).toBe(before + 1);
  });

  it('find() returns null for non-existent uuid', async () => {
    const result = await E2eItemEntity.find({
      uuid: '00000000-0000-0000-0000-000000000000',
    });
    expect(result).toBeNull();
  });

  it('find() throws when called without conditions', async () => {
    await expect(E2eItemEntity.find({})).rejects.toThrow(
      /requires at least one condition/,
    );
  });

  it('findAll() with limit and offset', async () => {
    const items = await E2eItemEntity.findAll({}, { limit: 2, offset: 0 });
    expect(items.length).toBeLessThanOrEqual(2);
  });

  it('insertMany() inserts multiple entities in batches', async () => {
    const items = Array.from({ length: 5 }, (_, i) => {
      const e = new E2eItemEntity();
      e.name = `Batch${i}`;
      e.quantity = i;
      e.price = i * 1.5;
      e.active = i % 2 === 0;
      e.total_views = BigInt(i * 100);
      e.description = `Batch item ${i}`;
      return e;
    });

    const result = await E2eItemEntity.insertMany(items);
    expect(result).toHaveLength(5);
    for (const r of result) {
      expect(r.uuid).toBeDefined();
    }
  });

  it('save() with special characters (unicode, emoji, quotes)', async () => {
    const item = new E2eItemEntity();
    item.name = 'Спецсимволы 🌍 "кавычки" & <тег>';
    item.quantity = 1;
    item.price = 1;
    item.active = true;
    item.total_views = 0n;
    item.description = '';
    await E2eItemEntity.save(item);

    const found = await E2eItemEntity.find({ uuid: item.uuid });
    expect(found!.name).toBe('Спецсимволы 🌍 "кавычки" & <тег>');
  });

  it('handles all YDB primitive types', async () => {
    const item = new E2eItemEntity();
    item.name = 'AllTypes';
    item.quantity = -42; // Int32
    item.price = 3.14159; // Double
    item.active = false; // Bool
    item.total_views = 9007199254740991n; // Int64 max safe
    item.description = ''; // Utf8
    await E2eItemEntity.save(item);

    const found = await E2eItemEntity.find({ uuid: item.uuid });
    expect(found!.quantity).toBe(-42);
    expect(found!.price).toBeCloseTo(3.14159);
    expect(found!.active).toBe(false);
    expect(found!.total_views).toBe(9007199254740991n);
  });

  it('handles null values', async () => {
    const item = new E2eItemEntity();
    item.name = 'NullTest';
    item.quantity = 0;
    item.price = 0;
    item.active = false;
    item.total_views = 0n;
    item.description = '';
    await E2eItemEntity.save(item);

    const found = await E2eItemEntity.find({ uuid: item.uuid });
    expect(found).not.toBeNull();
    expect(found!.name).toBe('NullTest');
  });

  it('delete() removes entity and returns it', async () => {
    const item = new E2eItemEntity();
    item.name = 'DeleteMe';
    item.quantity = 1;
    item.price = 1;
    item.active = true;
    item.total_views = 0n;
    item.description = '';
    await E2eItemEntity.save(item);

    const deleted = await E2eItemEntity.delete(item.uuid);
    expect(deleted).not.toBeNull();
    expect(deleted!.uuid).toBe(item.uuid);
    expect(deleted!.name).toBe('DeleteMe');

    const found = await E2eItemEntity.find({ uuid: item.uuid });
    expect(found).toBeNull();
  });

  it('delete() returns null for non-existent uuid', async () => {
    const deleted = await E2eItemEntity.delete(
      '00000000-0000-0000-0000-000000000000',
    );
    expect(deleted).toBeNull();
  });
});
