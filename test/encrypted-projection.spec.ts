import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import type { YdbEncryptionContext, YdbExecutor } from '../src/index.js';
import { serializeAadV2 } from '../src/index.js';
import { LazySecretEntity } from './fixtures/lazy_secret/lazy-secret.entity.js';
import { AadOverrideEntity } from './fixtures/aad_override/aad-override.entity.js';

/**
 * Строгий провайдер: decrypt падает, если переданный AAD не совпадает ни с
 * одним «принятым» (как реальная authenticate-then-decrypt схема). Позволяет
 * ловить чтение шифрованного поля с неполным AAD.
 */
class StrictAadProvider extends TestOnlyEncryptionProvider {
  accepted = new Set<string>();

  override async encrypt(
    plaintext: string,
    _aad: string,
    context: YdbEncryptionContext,
  ): Promise<Uint8Array> {
    this.accepted.add(_aad);
    return super.encrypt(plaintext, _aad, context);
  }

  override async decrypt(
    ciphertext: Uint8Array,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<string> {
    if (!this.accepted.has(aad)) {
      throw new Error('AAD mismatch');
    }
    return super.decrypt(ciphertext, aad, context);
  }
}

/**
 * Executor, эмулирующий реальную БД: возвращает строку только из тех колонок,
 * что перечислены в SELECT. Так проекция без AAD-колонки действительно
 * приводит к неполной строке.
 */
function createProjectingExecutor(fullRows: Record<string, any>[]) {
  const queries: { sql: string }[] = [];
  const executor: any = (strings: TemplateStringsArray) => {
    const sql = strings[0];
    queries.push({ sql });
    const selectPart = /SELECT ([\s\S]*?) FROM /.exec(sql)?.[1]?.trim();
    const columns =
      !selectPart || selectPart === '*'
        ? null
        : selectPart.split(',').map((c) => c.trim().replace(/`/g, ''));
    const resultRows = fullRows.map((row) => {
      if (!columns) return { ...row };
      const projected: Record<string, any> = {};
      for (const col of columns) {
        if (col in row) projected[col] = row[col];
      }
      return projected;
    });
    const query: any = {
      parameter() {
        return query;
      },
      timeout() {
        return query;
      },
      signal() {
        return query;
      },
      cancel() {
        return query;
      },
      idempotent() {
        return query;
      },
      then(onFulfilled: any, onRejected: any) {
        return Promise.resolve([resultRows]).then(onFulfilled, onRejected);
      },
    };
    return query;
  };
  return { executor: executor as YdbExecutor, queries };
}

const ct = (s: string) => new TextEncoder().encode(s);
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UUID_AAD = serializeAadV2(['uuid'], () => UUID);

function makeLazyRow() {
  return {
    uuid: UUID,
    tenant_id: 'tenant-1',
    secret_lazy: ct('lazy-secret-value'),
    secret_eager: ct('eager-secret-value'),
  };
}

function makeOverrideRow() {
  return {
    uuid: UUID,
    secret: ct('pin-secret-value'),
  };
}

function setupStrict(accepted: string): StrictAadProvider {
  const provider = new StrictAadProvider();
  provider.accepted.add(accepted);
  LazySecretEntity.setEncryptionProvider(provider);
  LazySecretEntity.setBlindIndexProvider(provider);
  AadOverrideEntity.setEncryptionProvider(provider);
  AadOverrideEntity.setBlindIndexProvider(provider);
  return provider;
}

describe('Security AAD retention in projections (#240)', () => {
  beforeEach(() => {
    setupStrict(UUID_AAD);
  });

  afterEach(() => {
    LazySecretEntity.setExecutor(undefined);
    LazySecretEntity.setEncryptionProvider(undefined);
    LazySecretEntity.setBlindIndexProvider(undefined);
    AadOverrideEntity.setExecutor(undefined);
    AadOverrideEntity.setEncryptionProvider(undefined);
    AadOverrideEntity.setBlindIndexProvider(undefined);
  });

  it('find(select encrypted) автоматически добавляет AAD-колонку и дешифрует', async () => {
    const row = makeLazyRow();
    const { executor, queries } = createProjectingExecutor([row]);
    LazySecretEntity.setExecutor(executor);

    const found = await LazySecretEntity.find(
      { uuid: row.uuid },
      { select: ['secret_eager'] },
    );

    expect(queries[0].sql).toMatch(/SELECT `secret_eager`, `uuid` FROM/);
    expect(found).not.toBeNull();
    expect(found!.secret_eager).toBe('eager-secret-value');
  });

  it('findAll(select encrypted) сохраняет AAD-колонку для каждой строки', async () => {
    const row = makeLazyRow();
    const { executor, queries } = createProjectingExecutor([row]);
    LazySecretEntity.setExecutor(executor);

    const found = await LazySecretEntity.findAll(
      {},
      { select: ['secret_eager'] },
    );

    expect(queries[0].sql).toMatch(/SELECT `secret_eager`, `uuid` FROM/);
    expect(found).toHaveLength(1);
    expect(found[0].secret_eager).toBe('eager-secret-value');
  });

  it('query-builder select сохраняет AAD-колонку', async () => {
    const row = makeLazyRow();
    const { executor, queries } = createProjectingExecutor([row]);
    LazySecretEntity.setExecutor(executor);

    const found = await LazySecretEntity.query()
      .select(['secret_eager'])
      .where({ uuid: row.uuid })
      .getMany();

    expect(queries[0].sql).toMatch(/SELECT `secret_eager`, `uuid` FROM/);
    expect(found).toHaveLength(1);
    expect(found[0].secret_eager).toBe('eager-secret-value');
  });

  it('lazy decryptField после проекции получает AAD-поле', async () => {
    const row = makeLazyRow();
    const { executor, queries } = createProjectingExecutor([row]);
    LazySecretEntity.setExecutor(executor);

    const found = (await LazySecretEntity.find(
      { uuid: row.uuid },
      { select: ['secret_lazy'] },
    ))!;

    expect(queries[0].sql).toMatch(/SELECT `secret_lazy`, `uuid` FROM/);
    expect(found.uuid).toBe(UUID);
    await expect(found.decryptField('secret_lazy')).resolves.toBe(
      'lazy-secret-value',
    );
  });

  it('lazy decryptLazyFields после проекции получает AAD-поле', async () => {
    const row = makeLazyRow();
    const { executor } = createProjectingExecutor([row]);
    LazySecretEntity.setExecutor(executor);

    const found = (await LazySecretEntity.find(
      { uuid: row.uuid },
      { select: ['secret_lazy'] },
    ))!;
    await found.decryptLazyFields();

    expect(found.secret_lazy).toBe('lazy-secret-value');
  });

  it('проекция только нешифрованных полей не тянет AAD-колонку', async () => {
    const row = makeLazyRow();
    const { executor, queries } = createProjectingExecutor([row]);
    LazySecretEntity.setExecutor(executor);

    await LazySecretEntity.find({ uuid: row.uuid }, { select: ['tenant_id'] });

    expect(queries[0].sql).toMatch(/SELECT `tenant_id` FROM/);
  });

  it('aadOverride-поле проецируется без AAD-колонки сущности', async () => {
    setupStrict('pin');
    const row = makeOverrideRow();
    const { executor, queries } = createProjectingExecutor([row]);
    AadOverrideEntity.setExecutor(executor);

    const found = await AadOverrideEntity.find(
      { uuid: row.uuid },
      { select: ['secret'] },
    );

    expect(queries[0].sql).toMatch(/SELECT `secret` FROM/);
    expect(found!.secret).toBe('pin-secret-value');
  });
});
