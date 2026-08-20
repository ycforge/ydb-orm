import 'reflect-metadata';
import { LazySecretEntity } from './fixtures/lazy_secret/lazy-secret.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { Base64TestEncryptionProvider } from '../src/encryption/base64-test-encryption.provider.js';
import type { YdbEncryptionContext } from '../src/index.js';

/**
 * Счётчик вызовов decrypt/encrypt по полям поверх Base64TestEncryptionProvider.
 */
class CountingEncryptionProvider extends Base64TestEncryptionProvider {
  decryptCalls: string[] = [];
  encryptCalls: string[] = [];
  decryptContexts: YdbEncryptionContext[] = [];

  override async decrypt(
    ciphertext: Uint8Array,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<string> {
    this.decryptCalls.push(context.fieldName);
    this.decryptContexts.push(context);
    return super.decrypt(ciphertext, aad, context);
  }

  override async encrypt(
    plaintext: string,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<Uint8Array> {
    this.encryptCalls.push(context.fieldName);
    return super.encrypt(plaintext, aad, context);
  }
}

// Base64TestEncryptionProvider сейчас "identity": ciphertext = utf8-байты plaintext
const ct = (s: string) => new TextEncoder().encode(s);
const biHash = (s: string) => Buffer.from(`bi:${s}`, 'utf8').toString('base64');

function makeRow() {
  return {
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    tenant_id: 'tenant-1',
    secret_lazy: ct('lazy-secret-value'),
    secret_lazy_bi: biHash('lazy-secret-value'),
    secret_eager: ct('eager-secret-value'),
  };
}

describe('lazy decrypt (@YdbEncrypted({ lazy: true }))', () => {
  let provider: CountingEncryptionProvider;

  beforeEach(() => {
    provider = new CountingEncryptionProvider();
    LazySecretEntity.setEncryptionProvider(provider);
    LazySecretEntity.setBlindIndexProvider(provider);
  });

  afterEach(() => {
    LazySecretEntity.setExecutor(undefined as any);
    LazySecretEntity.setEncryptionProvider(undefined as any);
    LazySecretEntity.setBlindIndexProvider(undefined as any);
  });

  it('не дешифрует lazy-поле при find, обычные поля дешифруются сразу', async () => {
    const mock = createMockExecutor([[makeRow()]]);
    LazySecretEntity.setExecutor(mock.executor);

    const entity = await LazySecretEntity.find({ uuid: makeRow().uuid });

    expect(entity).not.toBeNull();
    // decrypt вызван только для не-lazy поля
    expect(provider.decryptCalls).toEqual(['secret_eager']);
    // lazy-поле хранит ciphertext (Uint8Array), обычное — plaintext
    expect(entity!.secret_lazy).toEqual(ct('lazy-secret-value'));
    expect(entity!.secret_eager).toBe('eager-secret-value');
  });

  it('decryptField дешифрует, кеширует и передаёт AAD', async () => {
    const mock = createMockExecutor([[makeRow()]]);
    LazySecretEntity.setExecutor(mock.executor);

    const entity = (await LazySecretEntity.find({ uuid: makeRow().uuid }))!;
    provider.decryptCalls = [];

    const value = await entity.decryptField('secret_lazy');
    expect(value).toBe('lazy-secret-value');
    expect(entity.secret_lazy).toBe('lazy-secret-value');
    expect(provider.decryptCalls).toEqual(['secret_lazy']);

    // AAD собран из @YdbSecurityAAD-полей инстанса
    expect(provider.decryptContexts[0].aadFields).toEqual({
      uuid: makeRow().uuid,
    });
    expect(provider.decryptContexts[0].primaryKeyValue).toBe(makeRow().uuid);

    // Повторное обращение — из кеша, без вызова провайдера
    const again = await entity.decryptField('secret_lazy');
    expect(again).toBe('lazy-secret-value');
    expect(provider.decryptCalls).toHaveLength(1);
  });

  it('decryptLazyFields идемпотентен', async () => {
    const mock = createMockExecutor([[makeRow()]]);
    LazySecretEntity.setExecutor(mock.executor);

    const entity = (await LazySecretEntity.find({ uuid: makeRow().uuid }))!;

    await entity.decryptLazyFields();
    await entity.decryptLazyFields();

    expect(entity.secret_lazy).toBe('lazy-secret-value');
    expect(provider.decryptCalls).toEqual(['secret_eager', 'secret_lazy']);
  });

  it('decryptField бросает ошибку для не-lazy поля', async () => {
    const mock = createMockExecutor([[makeRow()]]);
    LazySecretEntity.setExecutor(mock.executor);

    const entity = (await LazySecretEntity.find({ uuid: makeRow().uuid }))!;
    await expect(entity.decryptField('secret_eager')).rejects.toThrow(
      'not a lazy encrypted field',
    );
  });

  it('toJSON бросает ошибку до дешифровки и отдаёт plaintext после', async () => {
    const mock = createMockExecutor([[makeRow()]]);
    LazySecretEntity.setExecutor(mock.executor);

    const entity = (await LazySecretEntity.find({ uuid: makeRow().uuid }))!;

    expect(() => entity.toJSON()).toThrow(/decryptLazyFields/);
    expect(() => JSON.stringify(entity)).toThrow(/decryptLazyFields/);

    await entity.decryptLazyFields();

    const json = entity.toJSON();
    expect(json.secret_lazy).toBe('lazy-secret-value');
    expect(json.secret_eager).toBe('eager-secret-value');
    expect(json).not.toHaveProperty('secret_lazy_bi');
  });

  it('save после чтения не зашифровывает ciphertext повторно', async () => {
    const row = makeRow();
    const mock = createMockExecutor([[row]]);
    LazySecretEntity.setExecutor(mock.executor);

    const entity = (await LazySecretEntity.find({ uuid: row.uuid }))!;
    entity.secret_eager = 'new-eager-value';

    // find() дешифрует мок-строку in-place; RETURNING при update читает
    // ту же строку — восстанавливаем ciphertext, как сделала бы реальная БД.
    row.secret_eager = ct('eager-secret-value');

    await LazySecretEntity.save(entity);

    // encrypt вызван только для изменённого не-lazy поля
    expect(provider.encryptCalls).toEqual(['secret_eager']);

    const updateQuery = mock.queries.find((q) => q.sql.includes('UPDATE'))!;
    expect(updateQuery).toBeDefined();
    // lazy-поле ушло в БД как исходный ciphertext, _bi не пересчитывался
    expect((updateQuery.params['secret_lazy'] as any).value).toEqual(
      row.secret_lazy,
    );
    expect(updateQuery.params).not.toHaveProperty('secret_lazy_bi');
  });

  it('save после decryptLazyFields перешифровывает plaintext корректно', async () => {
    const row = makeRow();
    const mock = createMockExecutor([[row]]);
    LazySecretEntity.setExecutor(mock.executor);

    const entity = (await LazySecretEntity.find({ uuid: row.uuid }))!;
    await entity.decryptLazyFields();

    // find() дешифрует мок-строку in-place; RETURNING при update читает
    // ту же строку — восстанавливаем ciphertext, как сделала бы реальная БД.
    row.secret_eager = ct('eager-secret-value');

    await LazySecretEntity.save(entity);

    expect(provider.encryptCalls.sort()).toEqual([
      'secret_eager',
      'secret_lazy',
    ]);
    const updateQuery = mock.queries.find((q) => q.sql.includes('UPDATE'))!;
    // Тестовый провайдер identity: ciphertext совпадает с исходными байтами
    expect((updateQuery.params['secret_lazy'] as any).value).toEqual(
      row.secret_lazy,
    );
    expect((updateQuery.params['secret_lazy_bi'] as any).value).toBe(
      row.secret_lazy_bi,
    );
  });

  it('blind index: поиск по lazy-полю транслируется в _bi колонку', async () => {
    const mock = createMockExecutor([[makeRow()]]);
    LazySecretEntity.setExecutor(mock.executor);

    await LazySecretEntity.find({ secret_lazy: 'lazy-secret-value' });

    const query = mock.queries[0];
    expect(query.sql).toContain('secret_lazy_bi');
    expect((query.params['secret_lazy_bi'] as any).value).toBe(
      biHash('lazy-secret-value'),
    );
    // Поиск по blind index не требует дешифровки значения
    expect(provider.decryptCalls).toEqual(['secret_eager']);
  });
});
