import {
  createE2eContext,
  closeE2eContext,
  hasYdbCredentials,
  createTableForEntity,
  dropTableForEntity,
  type E2eContext,
} from './setup.js';
import { E2eSecretEntity } from './entities.js';

let ctx: E2eContext | null = null;

beforeAll(async () => {
  ctx = await createE2eContext();
  if (!ctx) return;

  await createTableForEntity(ctx.executor, E2eSecretEntity);

  E2eSecretEntity.setExecutor(ctx.executor);
  E2eSecretEntity.setEncryptionProvider(ctx.encryptionProvider);
  E2eSecretEntity.setBlindIndexProvider(ctx.blindIndexProvider);
});

afterAll(async () => {
  if (!ctx) return;
  await dropTableForEntity(ctx.executor, E2eSecretEntity);
  E2eSecretEntity.setExecutor(undefined as any);
  E2eSecretEntity.setEncryptionProvider(undefined as any);
  E2eSecretEntity.setBlindIndexProvider(undefined as any);
  await closeE2eContext(ctx);
});

const describeE2e = () => (hasYdbCredentials() ? describe : describe.skip);

describeE2e()('Encryption e2e', () => {
  it('encrypts on save and decrypts on find (with blind index)', async () => {
    const secret = new E2eSecretEntity();
    secret.email = 'alice@example.com';
    secret.notes = 'some private notes';
    secret.plaintext = 'not encrypted';

    await E2eSecretEntity.save(secret);

    const found = await E2eSecretEntity.find({ uuid: secret.uuid });
    expect(found).not.toBeNull();
    // Encrypted fields should be decrypted on read
    expect(found!.email).toBe('alice@example.com');
    expect(found!.notes).toBe('some private notes');
    expect(found!.plaintext).toBe('not encrypted');
  });

  it('searches by encrypted field via blind index', async () => {
    const secret = new E2eSecretEntity();
    secret.email = 'bob@example.com';
    secret.notes = 'bob notes';
    secret.plaintext = 'bob plaintext';
    await E2eSecretEntity.save(secret);

    // Search by email (has blind index) — should find by blind index hash
    const found = await E2eSecretEntity.find({ email: 'bob@example.com' });
    expect(found).not.toBeNull();
    expect(found!.email).toBe('bob@example.com');
    expect(found!.notes).toBe('bob notes');
  });

  it('search by encrypted field without blind index throws', async () => {
    await expect(E2eSecretEntity.find({ notes: 'some notes' })).rejects.toThrow(
      /without blind index/,
    );
  });

  it('handles null encrypted fields', async () => {
    const secret = new E2eSecretEntity();
    secret.email = 'null-test@example.com';
    secret.notes = null as any;
    secret.plaintext = 'has value';
    await E2eSecretEntity.save(secret);

    const found = await E2eSecretEntity.find({ uuid: secret.uuid });
    expect(found).not.toBeNull();
    expect(found!.email).toBe('null-test@example.com');
    expect(found!.notes).toBeNull();
  });

  it('handles empty string encrypted fields', async () => {
    const secret = new E2eSecretEntity();
    secret.email = 'empty@example.com';
    secret.notes = '';
    secret.plaintext = '';
    await E2eSecretEntity.save(secret);

    const found = await E2eSecretEntity.find({ uuid: secret.uuid });
    expect(found).not.toBeNull();
    expect(found!.email).toBe('empty@example.com');
    expect(found!.notes).toBe('');
  });

  it('handles unicode and emoji in encrypted fields', async () => {
    const secret = new E2eSecretEntity();
    secret.email = 'юзер@пример.рф';
    secret.notes = 'Привет 🌍';
    secret.plaintext = 'plain unicode';
    await E2eSecretEntity.save(secret);

    const found = await E2eSecretEntity.find({ uuid: secret.uuid });
    expect(found!.email).toBe('юзер@пример.рф');
    expect(found!.notes).toBe('Привет 🌍');
  });

  it('update encrypted field', async () => {
    const secret = new E2eSecretEntity();
    secret.email = 'update-old@example.com';
    secret.notes = 'old notes';
    secret.plaintext = 'unchanged';
    await E2eSecretEntity.save(secret);

    secret.email = 'update-new@example.com';
    secret.notes = 'new notes';
    await E2eSecretEntity.save(secret);

    const found = await E2eSecretEntity.find({ uuid: secret.uuid });
    expect(found!.email).toBe('update-new@example.com');
    expect(found!.notes).toBe('new notes');

    // Old email should not be findable
    const oldFound = await E2eSecretEntity.find({
      email: 'update-old@example.com',
    });
    expect(oldFound).toBeNull();
  });
});
