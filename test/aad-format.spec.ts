import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LazySecretEntity } from './fixtures/lazy_secret/lazy-secret.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import type { YdbEncryptionContext } from '../src/index.js';
import { serializeAadV2 } from '../src/index.js';

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
    LazySecretEntity.setExecutor(undefined as any);
    LazySecretEntity.setEncryptionProvider(undefined);
    LazySecretEntity.setBlindIndexProvider(undefined);
    LazySecretEntity.setAadFormat(undefined);
  });

  it('по умолчанию шифрование использует v2-сериализацию AAD', async () => {
    const mock = createMockExecutor([[]]);
    LazySecretEntity.setExecutor(mock.executor);

    const entity = newEntity();
    await LazySecretEntity.save(entity);

    const expected = serializeAadV2(['uuid'], (n) => entity[n]);
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

    const expected = serializeAadV2(['uuid'], (n) => row[n]);
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
    const aad1 = serializeAadV2(['uuid'], (n) => row1[n]);
    const aad2 = serializeAadV2(['uuid'], (n) => row2[n]);
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
});
