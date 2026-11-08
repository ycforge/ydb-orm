import 'reflect-metadata';
import { UserEntity } from './fixtures/user/user.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { RecordingEncryptionProvider } from './helpers/recording-encryption-provider.js';
import { INSERT_MANY_ENCRYPTION_CONCURRENCY } from '../src/persistence/entity-persistence.js';

function makeUsers(count: number): UserEntity[] {
  return Array.from({ length: count }, (_, i) => {
    const user = new UserEntity();
    user.email_encrypted = `email-${i}`;
    user.full_name = `name-${i}`;
    return user;
  });
}

describe('insertMany() bounded preprocessing (#234)', () => {
  afterEach(() => {
    UserEntity.setExecutor(undefined as any);
    UserEntity.setEncryptionProvider(undefined);
    UserEntity.setBlindIndexProvider(undefined);
  });

  it('never exceeds the encryption concurrency ceiling', async () => {
    const provider = new RecordingEncryptionProvider(2);
    UserEntity.setEncryptionProvider(provider);
    UserEntity.setBlindIndexProvider(provider);
    const mock = createMockExecutor([[]]);
    UserEntity.setExecutor(mock.executor);

    await UserEntity.insertMany(makeUsers(150));

    expect(provider.encryptCalls).toBe(300);
    expect(provider.maxActive).toBeGreaterThan(1);
    expect(provider.maxActive).toBeLessThanOrEqual(
      INSERT_MANY_ENCRYPTION_CONCURRENCY,
    );
    expect(provider.maxActive).toBe(INSERT_MANY_ENCRYPTION_CONCURRENCY);
  });

  it('stops before preprocessing batches after a failed one', async () => {
    const provider = new RecordingEncryptionProvider(0, 'boom');
    UserEntity.setEncryptionProvider(provider);
    UserEntity.setBlindIndexProvider(provider);
    const mock = createMockExecutor([[]]);
    UserEntity.setExecutor(mock.executor);

    const users = makeUsers(150);
    users[50].full_name = 'boom';

    await expect(UserEntity.insertMany(users)).rejects.toThrow(
      /forced failure/,
    );

    // Failure is inside the first SQL batch, so it never reaches a write and
    // later batches are never preprocessed.
    expect(mock.queries).toHaveLength(0);
    expect(provider.encryptedPlaintexts).not.toContain('email-149');
    expect(provider.encryptedPlaintexts).not.toContain('name-149');
  });
});
