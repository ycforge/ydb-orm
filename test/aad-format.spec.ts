import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LazySecretEntity } from './fixtures/lazy_secret/lazy-secret.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import type { YdbEncryptionContext } from '../src/index.js';
import { serializeAadV2 } from '../src/index.js';
import {
  YdbEntity,
  YdbPrimaryColumn,
  YdbSecurityAAD,
  YdbEncrypted,
} from '../src/index.js';
import { YdbBaseEntity } from '../src/index.js';

/**
 * Провайдер, записывающий aad-строки поверх TestOnlyEncryptionProvider.
 */
class AadRecordingProvider extends TestOnlyEncryptionProvider {
  encryptAads: string[] = [];
  decryptAads: string[] = [];

  override async encrypt(
    plaintext: string,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<Uint8Array> {
    this.encryptAads.push(aad);
    return super.encrypt(plaintext, aad, context);
  }

  override async decrypt(
    ciphertext: Uint8Array,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<string> {
    this.decryptAads.push(aad);
    return super.decrypt(ciphertext, aad, context);
  }
}

const ct = (s: string) => new TextEncoder().encode(s);
const biHash = (s: string) => Buffer.from(`bi:${s}`, 'utf8').toString('base64');

/**
 * Провайдер-симулятор реального AEAD для тестов миграции форматов (#165):
 * decrypt падает на AAD, которого нет в accepted — как реальная
 * authenticate-then-decrypt схема падает при несовпадении AAD.
 */
class StrictAadProvider extends TestOnlyEncryptionProvider {
  encryptAads: string[] = [];
  decryptAttempts: string[] = [];
  accepted = new Set<string>();

  override async encrypt(
    plaintext: string,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<Uint8Array> {
    this.encryptAads.push(aad);
    this.accepted.add(aad);
    return super.encrypt(plaintext, aad, context);
  }

  override async decrypt(
    ciphertext: Uint8Array,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<string> {
    this.decryptAttempts.push(aad);
    if (!this.accepted.has(aad)) {
      throw new Error('AAD mismatch');
    }
    return super.decrypt(ciphertext, aad, context);
  }
}

@YdbEntity('aad_fallback_override')
class OverrideEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbEncrypted({ aadOverride: 'pin' })
  secret: string;
}

@YdbEntity('aad_date_pk')
class AadDateEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Datetime')
  declare dt: Date;

  @YdbEncrypted()
  declare secret: string;
}

@YdbEntity('aad_bytes_pk')
class AadBytesEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Bytes')
  declare key: Uint8Array;

  @YdbEncrypted()
  declare secret: string;
}

const legacyAad = (row: Record<string, any>): string => `uuid=${row.uuid}`;
const v2Aad = (row: Record<string, any>): string =>
  serializeAadV2(['uuid'], (n) => row[n]);

function makeRow() {
  return {
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    tenant_id: 'tenant-1',
    secret_lazy: ct('lazy-secret-value'),
    secret_lazy_bi: biHash('lazy-secret-value'),
    secret_eager: ct('eager-secret-value'),
  };
}

/** Новый инстанс без PK: save() уходит в UPSERT и генерирует uuid. */
function newEntity() {
  const entity = new LazySecretEntity();
  entity.tenant_id = 'tenant-1';
  entity.secret_lazy = 'lazy-secret-value';
  entity.secret_eager = 'eager-secret-value';
  return entity;
}

describe('Security AAD format (#165)', () => {
  let provider: AadRecordingProvider;

  beforeEach(() => {
    provider = new AadRecordingProvider();
    LazySecretEntity.setEncryptionProvider(provider);
    LazySecretEntity.setBlindIndexProvider(provider);
  });

  afterEach(() => {
    LazySecretEntity.setExecutor(undefined);
    LazySecretEntity.setEncryptionProvider(undefined);
    LazySecretEntity.setBlindIndexProvider(undefined);
    LazySecretEntity.setAadFormat(undefined);
    LazySecretEntity.setAadReadFallback(undefined);
    OverrideEntity.setExecutor(undefined);
    OverrideEntity.setEncryptionProvider(undefined);
    OverrideEntity.setBlindIndexProvider(undefined);
    AadDateEntity.setExecutor(undefined);
    AadDateEntity.setEncryptionProvider(undefined);
    AadDateEntity.setBlindIndexProvider(undefined);
    AadBytesEntity.setExecutor(undefined);
    AadBytesEntity.setEncryptionProvider(undefined);
    AadBytesEntity.setBlindIndexProvider(undefined);
  });

  it('по умолчанию шифрование использует v2-сериализацию AAD', async () => {
    const mock = createMockExecutor([[]]);
    LazySecretEntity.setExecutor(mock.executor);

    const entity = newEntity();
    await LazySecretEntity.save(entity);

    const expected = serializeAadV2(
      ['uuid'],
      (n) => (entity as unknown as Record<string, unknown>)[n],
    );
    expect(expected.startsWith('v2:')).toBe(true);
    expect(provider.encryptAads.length).toBe(2);
    for (const aad of provider.encryptAads) {
      expect(aad).toBe(expected);
    }
    // legacy-сериализация не должна использоваться по умолчанию
    expect(provider.encryptAads).not.toContain(`uuid=${entity.uuid}`);
  });

  it('дешифровка при чтении использует ту же v2-сериализацию', async () => {
    const row = makeRow();
    const mock = createMockExecutor([[row]]);
    LazySecretEntity.setExecutor(mock.executor);

    await LazySecretEntity.find({ uuid: row.uuid });

    const expected = serializeAadV2(
      ['uuid'],
      (n) => row[n as keyof typeof row],
    );
    // дешифруется только eager-поле (lazy остаётся ciphertext)
    expect(provider.decryptAads).toEqual([expected]);
  });

  it('v2-сериализация различает записи, которые legacy смешивал', () => {
    // UUID фиксирован, но value с «;» и «=» внутри: legacy-строка
    // `uuid=...` была бы одинаковой для разных значений только при разных
    // наборах AAD-полей; здесь проверяем, что v2 всегда различает значения,
    // размещая длину значения перед ним.
    const row1 = makeRow();
    const row2 = makeRow();
    const aad1 = serializeAadV2(['uuid'], (n) => row1[n as keyof typeof row1]);
    const aad2 = serializeAadV2(['uuid'], (n) => row2[n as keyof typeof row2]);
    expect(aad1).toBe(aad2);
    expect(aad1).toContain(`${row1.uuid.length}:${row1.uuid}`);
  });

  it('setAadFormat("legacy") возвращает исторический формат name=value', async () => {
    LazySecretEntity.setAadFormat('legacy');
    const row = makeRow();
    const mock = createMockExecutor([[row]]);
    LazySecretEntity.setExecutor(mock.executor);

    await LazySecretEntity.find({ uuid: row.uuid });

    expect(provider.decryptAads).toEqual([`uuid=${row.uuid}`]);
  });

  it('legacy-режим шифрования обратим через тот же формат', async () => {
    LazySecretEntity.setAadFormat('legacy');
    const mock = createMockExecutor([[]]);
    LazySecretEntity.setExecutor(mock.executor);

    const entity = newEntity();
    await LazySecretEntity.save(entity);

    const expected = `uuid=${entity.uuid}`;
    expect(provider.encryptAads.length).toBe(2);
    expect(provider.encryptAads).toEqual([expected, expected]);
  });

  it('смена формата после бутстрапа пересоздаёт repository', async () => {
    const row = makeRow();
    const row2 = makeRow();
    const mock = createMockExecutor([[row]]);
    LazySecretEntity.setExecutor(mock.executor);

    // сначала repository уже построен с v2
    await LazySecretEntity.find({ uuid: row.uuid });
    expect(provider.decryptAads[0].startsWith('v2:')).toBe(true);

    // меняем формат на живой конфигурации без повторного провайдера
    LazySecretEntity.setAadFormat('legacy');
    const mock2 = createMockExecutor([[row2]]);
    LazySecretEntity.setExecutor(mock2.executor);

    await LazySecretEntity.find({ uuid: row2.uuid });
    expect(provider.decryptAads[1]).toBe(`uuid=${row2.uuid}`);
  });

  it('legacy-строка читается по умолчанию: v2 падает, fallback пробует legacy', async () => {
    const row = makeRow();
    const strict = new StrictAadProvider();
    strict.accepted.add(legacyAad(row)); // ciphertext написан legacy-форматом
    LazySecretEntity.setEncryptionProvider(strict);
    LazySecretEntity.setBlindIndexProvider(strict);
    LazySecretEntity.setExecutor(createMockExecutor([[row]]).executor);

    const found = await LazySecretEntity.find({ uuid: row.uuid });

    expect(found?.secret_eager).toBe('eager-secret-value');
    // ровно две попытки: первичный v2 (упал) + fallback legacy (успех)
    expect(strict.decryptAttempts).toEqual([v2Aad(row), legacyAad(row)]);
  });

  it('переходный режим: legacy читается, перешифровка пишет v2, после строгого переключения — один формат', async () => {
    const row = makeRow();
    const provider = new StrictAadProvider();
    provider.accepted.add(legacyAad(row));
    LazySecretEntity.setEncryptionProvider(provider);
    LazySecretEntity.setBlindIndexProvider(provider);
    LazySecretEntity.setExecutor(createMockExecutor([[row]]).executor);

    const found = await LazySecretEntity.find({ uuid: row.uuid });
    expect(found).not.toBeNull();

    // Сохранение найденного инстанса переносит запись в v2-формат.
    // (decryptResult мутирует строку в plaintext — для RETURNING нужна
    // свежая строка с ciphertext.)
    const saveRow = makeRow();
    LazySecretEntity.setExecutor(createMockExecutor([[saveRow]]).executor);
    await LazySecretEntity.save(found!);
    expect(provider.encryptAads).toEqual([v2Aad(row)]);

    // Строгая фаза (fallback выключен): только v2, без повторов.
    const strict = new StrictAadProvider();
    strict.accepted.add(v2Aad(row));
    LazySecretEntity.setEncryptionProvider(strict);
    LazySecretEntity.setBlindIndexProvider(strict);
    LazySecretEntity.setAadReadFallback(false);
    const strictRow = makeRow();
    LazySecretEntity.setExecutor(createMockExecutor([[strictRow]]).executor);

    const migrated = await LazySecretEntity.find({ uuid: row.uuid });
    expect(migrated?.secret_eager).toBe('eager-secret-value');
    expect(strict.decryptAttempts).toEqual([v2Aad(row)]);
  });

  it('смешанный набор: legacy и v2-строки читаются в одном запросе', async () => {
    const legacyRow = makeRow();
    const v2Row = makeRow();
    v2Row.uuid = '11111111-2222-3333-4444-555555555555';

    const strict = new StrictAadProvider();
    strict.accepted.add(legacyAad(legacyRow));
    strict.accepted.add(v2Aad(v2Row));
    LazySecretEntity.setEncryptionProvider(strict);
    LazySecretEntity.setBlindIndexProvider(strict);
    LazySecretEntity.setExecutor(
      createMockExecutor([[legacyRow, v2Row]]).executor,
    );

    const rows = await LazySecretEntity.findAll({});
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.secret_eager).sort()).toEqual([
      'eager-secret-value',
      'eager-secret-value',
    ]);
    // legacy-строка: v2 (упал) + legacy (успех); v2-строка: одна попытка
    expect(strict.decryptAttempts).toEqual([
      v2Aad(legacyRow),
      legacyAad(legacyRow),
      v2Aad(v2Row),
    ]);
  });

  it('строгий режим (aadReadFallback=false) падает на legacy-строке без повторов', async () => {
    const row = makeRow();
    const strict = new StrictAadProvider();
    strict.accepted.add(legacyAad(row));
    LazySecretEntity.setEncryptionProvider(strict);
    LazySecretEntity.setBlindIndexProvider(strict);
    LazySecretEntity.setAadReadFallback(false);
    LazySecretEntity.setExecutor(createMockExecutor([[row]]).executor);

    await expect(LazySecretEntity.find({ uuid: row.uuid })).rejects.toThrow(
      'AAD mismatch',
    );
    // одна попытка: primary v2, fallback не включался
    expect(strict.decryptAttempts).toEqual([v2Aad(row)]);
  });

  it('aadOverride не делает fallback-повторов (формат AAD не при чём)', async () => {
    const row = {
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      secret: ct('pin-secret'),
    };
    const strict = new StrictAadProvider();
    OverrideEntity.setEncryptionProvider(strict);
    OverrideEntity.setBlindIndexProvider(strict);
    OverrideEntity.setExecutor(createMockExecutor([[row]]).executor);

    await expect(OverrideEntity.find({ uuid: row.uuid })).rejects.toThrow(
      'AAD mismatch',
    );
    // единственная попытка с override-AAD, ни legacy, ни v2 не пробуются
    expect(strict.decryptAttempts).toEqual(['pin']);
  });

  it('updateBy() шифрует Date-AAD тем же каноническим AAD, что и save()', async () => {
    const provider = new AadRecordingProvider();
    AadDateEntity.setEncryptionProvider(provider);
    AadDateEntity.setBlindIndexProvider(provider);
    const dt = new Date('2026-05-01T10:20:30.000Z');

    // save() с заданным PK идёт update-путём; AAD из buildAAD(entity) →
    // toAadString(Date) = ISO без JSON-кавычек.
    const entity = new AadDateEntity();
    entity.dt = dt;
    entity.secret = 'date-secret';
    AadDateEntity.setExecutor(
      createMockExecutor([[{ dt, secret: ct('date-secret') }]]).executor,
    );
    await AadDateEntity.save(entity);
    const saveAad = provider.encryptAads[0];

    provider.encryptAads.length = 0;
    AadDateEntity.setExecutor(createMockExecutor([[{ dt }]]).executor);
    await AadDateEntity.updateBy({ dt }, { secret: 'updated' });
    const updateAad = provider.encryptAads[0];

    expect(saveAad).toBe(updateAad);
    expect(updateAad).toBe(serializeAadV2(['dt'], () => dt));
  });

  it('updateBy() шифрует Bytes-AAD каноническим base64, а не JSON-сериализацией', async () => {
    const provider = new AadRecordingProvider();
    AadBytesEntity.setEncryptionProvider(provider);
    AadBytesEntity.setBlindIndexProvider(provider);
    const key = new TextEncoder().encode('binary-key');

    const entity = new AadBytesEntity();
    entity.key = key;
    entity.secret = 'bytes-secret';
    AadBytesEntity.setExecutor(
      createMockExecutor([[{ key, secret: ct('bytes-secret') }]]).executor,
    );
    await AadBytesEntity.save(entity);
    const saveAad = provider.encryptAads[0];

    provider.encryptAads.length = 0;
    AadBytesEntity.setExecutor(createMockExecutor([[{ key }]]).executor);
    await AadBytesEntity.updateBy({ key }, { secret: 'updated' });
    const updateAad = provider.encryptAads[0];

    expect(saveAad).toBe(updateAad);
    expect(updateAad).toBe(serializeAadV2(['key'], () => key));
  });
});
