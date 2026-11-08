import 'reflect-metadata';
import { describe, beforeAll, afterAll, it, expect } from '@jest/globals';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import {
  YdbBaseEntity,
  YdbEntity,
  YdbPrimaryColumn,
  YdbSecurityAAD,
  YdbEncrypted,
  createExecutor,
} from '../../src/index.js';
import type {
  YdbEncryptionProvider,
  YdbBlindIndexProvider,
  YdbEncryptionContext,
} from '../../src/index.js';
import {
  createTableForEntity,
  createE2eContext,
  hasYdbCredentials,
  type E2eContext,
} from './setup.js';

const table = `bound_${Date.now()}`;
@YdbEntity(table)
class BoundRow extends YdbBaseEntity {
  @YdbSecurityAAD() @YdbPrimaryColumn('Utf8') tenant!: string;
  @YdbPrimaryColumn('Utf8') id!: string;
  @YdbEncrypted({ lazy: true }) secret!: string;
}
const suite = hasYdbCredentials() ? describe : describe.skip;
suite('complete encryption binding against YDB', () => {
  let ctx: E2eContext;
  beforeAll(async () => {
    ctx = (await createE2eContext())!;
    const key = randomBytes(32),
      indexKey = randomBytes(32);
    const aadBytes = (aad: string, context: YdbEncryptionContext) =>
      Buffer.from(
        JSON.stringify([
          context.tableName,
          context.fieldName,
          context.primaryKeyValue,
          aad,
        ]),
      );
    const provider: YdbEncryptionProvider & YdbBlindIndexProvider = {
      encrypt(plaintext, aad, context) {
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aadBytes(aad, context));
        const ciphertext = Buffer.concat([
          cipher.update(plaintext, 'utf8'),
          cipher.final(),
        ]);
        return Promise.resolve(
          Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
        );
      },
      decrypt(value, aad, context) {
        const bytes = Buffer.from(value),
          decipher = createDecipheriv(
            'aes-256-gcm',
            key,
            bytes.subarray(0, 12),
          );
        decipher.setAAD(aadBytes(aad, context));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Promise.resolve(
          Buffer.concat([
            decipher.update(bytes.subarray(28)),
            decipher.final(),
          ]).toString(),
        );
      },
      hash(value, context) {
        return Promise.resolve(
          createHmac('sha256', indexKey)
            .update(
              JSON.stringify([context.tableName, context.fieldName, value]),
            )
            .digest('base64'),
        );
      },
    };
    const executor = createExecutor(ctx.driver, { endpoint: 'unused' });
    BoundRow.setExecutor(executor);
    BoundRow.setEncryptionProvider(provider);
    BoundRow.setBlindIndexProvider(provider);
    await createTableForEntity(executor, BoundRow);
    await BoundRow.insertMany([
      Object.assign(new BoundRow(), { tenant: 'a:b', id: 'c', secret: 'one' }),
      Object.assign(new BoundRow(), { tenant: 'a', id: 'b:c', secret: 'two' }),
    ]);
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
  });

  it('keeps the full composite PK in an encrypted projection and decrypts lazily', async () => {
    const row = await BoundRow.find(
      { tenant: 'a:b', id: 'c' },
      { select: ['secret'] },
    );
    expect(row?.tenant).toBe('a:b');
    expect(row?.id).toBe('c');
    await expect(row!.decryptField('secret')).resolves.toBe('one');
  });
  it('uses the same searchable field domain on writes, filters and equality updates', async () => {
    const row = await BoundRow.find({ secret: 'two' });
    expect(row?.tenant).toBe('a');
    await BoundRow.updateBy(
      { tenant: { $eq: 'a' }, id: { $eq: 'b:c' } },
      { secret: 'updated' },
    );
    const updated = await BoundRow.find({ secret: 'updated' });
    await expect(updated!.decryptField('secret')).resolves.toBe('updated');
    await expect(BoundRow.find({ secret: 'two' })).resolves.toBeNull();
  });
  it('rejects changed lazy binding before overwriting an existing target row', async () => {
    const row = await BoundRow.find({ tenant: 'a:b', id: 'c' });
    row!.tenant = 'a';
    row!.id = 'b:c';
    await expect(BoundRow.save(row!)).rejects.toThrow(
      'Decrypt it before changing',
    );
    const original = await BoundRow.find({ tenant: 'a', id: 'b:c' });
    await expect(original!.decryptField('secret')).resolves.toBe('updated');
  });
});
