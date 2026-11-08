import 'reflect-metadata';
import { describe, it, expect } from '@jest/globals';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { toJs } from '@ydbjs/value';
import type { Value } from '@ydbjs/value';
import { mapToYdb } from '../src/core/mapper.js';
import {
  YdbBaseEntity,
  YdbEntity,
  YdbPrimaryColumn,
  YdbSecurityAAD,
  YdbEncrypted,
  getOrCreateRepository,
  getYdbEntityMetadata,
} from '../src/index.js';
import type {
  YdbEncryptionContext,
  YdbEncryptionProvider,
} from '../src/index.js';
import { createMockExecutor } from './helpers/mock-executor.js';

@YdbEntity('binding_records')
class RecordEntity extends YdbBaseEntity {
  @YdbSecurityAAD() @YdbPrimaryColumn('Utf8') tenant!: string;
  @YdbPrimaryColumn('Utf8') id!: string;
  @YdbEncrypted({ lazy: true, blindIndex: false }) secret!: string;
}
@YdbEntity('binding_temporal')
class Temporal extends YdbBaseEntity {
  @YdbSecurityAAD() @YdbPrimaryColumn('Datetime') at!: Date;
  @YdbPrimaryColumn('Bytes') binary!: Uint8Array;
  @YdbEncrypted({ lazy: true, blindIndex: false, aadOverride: '' })
  secret!: string;
}
function setup(Entity: typeof RecordEntity | typeof Temporal = RecordEntity) {
  const key = randomBytes(32);
  const contexts: YdbEncryptionContext[] = [];
  const bound = (aad: string, ctx: YdbEncryptionContext) =>
    Buffer.from(
      JSON.stringify([ctx.tableName, ctx.fieldName, ctx.primaryKeyValue, aad]),
    );
  const provider: YdbEncryptionProvider = {
    encrypt(plaintext, aad, ctx) {
      contexts.push(ctx);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(bound(aad, ctx));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      return Promise.resolve(
        Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
      );
    },
    decrypt(value, aad, ctx) {
      contexts.push(ctx);
      const bytes = Buffer.from(value);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(bound(aad, ctx));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Promise.resolve(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
    },
  };
  Entity.setEncryptionProvider(provider);
  const persistence = getOrCreateRepository(
    Entity as typeof RecordEntity,
  ).persistence;
  return { persistence, contexts };
}

describe('authenticated encryption context', () => {
  it('uses the complete unambiguous PK for lazy encrypt/decrypt', async () => {
    const { persistence, contexts } = setup();
    const encrypted = await persistence.encryptEntity({
      tenant: 'a:b',
      id: 'c',
      secret: 'value',
    });
    const instance = persistence.instantiate(encrypted);
    await expect(persistence.decryptField(instance, 'secret')).resolves.toBe(
      'value',
    );
    expect(contexts[1].primaryKeyValue).toBe(contexts[0].primaryKeyValue);
    expect(JSON.parse(contexts[0].primaryKeyValue!)).toEqual([
      'pk:v1',
      [
        ['tenant', 'Utf8', 'a:b'],
        ['id', 'Utf8', 'c'],
      ],
    ]);
    const other = persistence.pkValueForContext(
      getYdbEntityMetadata(RecordEntity)!,
      { tenant: 'a', id: 'b:c' },
    );
    expect(other).not.toBe(contexts[0].primaryKeyValue);
    expect(
      persistence.pkValueForContext(getYdbEntityMetadata(RecordEntity)!, {
        tenant: 'a',
      }),
    ).toBeUndefined();
  });

  it.each(['tenant', 'id'])(
    'rejects lazy reuse after changing %s, before any DB query',
    async (field) => {
      const { persistence } = setup();
      const encrypted = await persistence.encryptEntity({
        tenant: 'one',
        id: 'two',
        secret: 'value',
      });
      const instance = persistence.instantiate(encrypted);
      (instance as unknown as Record<string, unknown>)[field] = 'changed';
      const mock = createMockExecutor([[]]);
      RecordEntity.setExecutor(mock.executor);
      await expect(RecordEntity.save(instance)).rejects.toThrow(
        'Decrypt it before changing',
      );
      expect(mock.queries).toHaveLength(0);
      await expect(
        persistence.decryptField(instance, 'secret'),
      ).rejects.toThrow('Restore the original binding');
    },
  );

  it('allows rebinding once plaintext has been explicitly decrypted', async () => {
    const { persistence } = setup();
    const row = await persistence.encryptEntity({
      tenant: 'one',
      id: 'two',
      secret: 'value',
    });
    const instance = persistence.instantiate(row);
    await persistence.decryptField(instance, 'secret');
    instance.id = 'new';
    const rewritten = await persistence.encryptEntity(
      { ...instance },
      instance,
    );
    await expect(
      persistence.decryptField(persistence.instantiate(rewritten), 'secret'),
    ).resolves.toBe('value');
  });

  it('normalizes temporal and binary PKs to the same stored identity', async () => {
    const { persistence, contexts } = setup(Temporal);
    const at = new Date('2026-01-01T12:00:00.789Z');
    const binary = new Uint8Array([0, 255]);
    const row = await persistence.encryptEntity({
      at,
      binary,
      secret: 'value',
    });
    row.at = toJs(mapToYdb('Datetime', at) as Value);
    await expect(
      persistence.decryptField(persistence.instantiate(row), 'secret'),
    ).resolves.toBe('value');
    expect(contexts[1].primaryKeyValue).toBe(contexts[0].primaryKeyValue);
  });

  it('resolves equality predicates to the same context and refuses bulk ciphertext reuse', async () => {
    const { persistence, contexts } = setup();
    const mock = createMockExecutor([[]]);
    RecordEntity.setExecutor(mock.executor);
    await RecordEntity.updateBy(
      { tenant: { $eq: 'one' }, id: { $eq: 'two' } },
      { secret: 'value' },
    );
    expect(contexts[0].primaryKeyValue).toBe(
      persistence.pkValueForContext(getYdbEntityMetadata(RecordEntity)!, {
        tenant: 'one',
        id: 'two',
      }),
    );
    await expect(
      RecordEntity.updateBy({ tenant: 'one' }, { secret: 'value' }),
    ).rejects.toThrow('complete primary key');
  });
});
