import 'reflect-metadata';
import { PhotoEntity } from './fixtures/photo/photo.entity.js';
import { UserEntity } from './fixtures/user/user.entity.js';
import { UserRoleEntity } from './fixtures/user_role/user_role.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { Base64TestEncryptionProvider } from '../src/encryption/base64-test-encryption.provider.js';

describe('toJSON()', () => {
  afterEach(() => {
    PhotoEntity.setExecutor(undefined as any);
    PhotoEntity.setEncryptionProvider(undefined as any);
    PhotoEntity.setBlindIndexProvider(undefined as any);
    UserEntity.setExecutor(undefined as any);
    UserEntity.setEncryptionProvider(undefined as any);
    UserEntity.setBlindIndexProvider(undefined as any);
    UserRoleEntity.setExecutor(undefined as any);
  });

  describe('entity with blind index (PhotoEntity)', () => {
    it('excludes _bi synthetic columns', async () => {
      const photoRow = {
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        title: 'Sunset',
        description: 'A nice sunset',
        width: 1920,
        height: 1080,
        file_size: BigInt(2048000),
        rating: 4.5,
        is_public: true,
        author_email: 'author@example.com',
        author_email_bi: 'hash-value-should-not-appear',
        like_count: 42,
      };

      const mock = createMockExecutor([[photoRow]]);
      PhotoEntity.setExecutor(mock.executor);

      const photo = await PhotoEntity.find({ uuid: photoRow.uuid });
      expect(photo).not.toBeNull();

      const json = photo!.toJSON();
      expect(json).not.toHaveProperty('author_email_bi');
      expect(json).toHaveProperty('uuid', photoRow.uuid);
      expect(json).toHaveProperty('title', 'Sunset');
      expect(json).toHaveProperty('author_email', 'author@example.com');
      expect(json).toHaveProperty('like_count', 42);
    });

    it('includes all regular fields', async () => {
      const photoRow = {
        uuid: '11111111-2222-3333-4444-555555555555',
        title: 'Portrait',
        description: 'A portrait',
        width: 800,
        height: 600,
        file_size: BigInt(1024000),
        rating: 3.0,
        is_public: false,
        author_email: 'test@test.com',
        author_email_bi: 'blind',
        like_count: 7,
      };

      const mock = createMockExecutor([[photoRow]]);
      PhotoEntity.setExecutor(mock.executor);

      const photo = await PhotoEntity.find({ uuid: photoRow.uuid });
      const json = photo!.toJSON();

      const expectedKeys = [
        'uuid',
        'title',
        'description',
        'width',
        'height',
        'file_size',
        'rating',
        'is_public',
        'author_email',
        'like_count',
      ];
      for (const key of expectedKeys) {
        expect(json).toHaveProperty(key);
      }
    });
  });

  describe('entity with encrypted fields (UserEntity)', () => {
    it('includes decrypted encrypted fields', async () => {
      const provider = new Base64TestEncryptionProvider();
      // encrypted fields в mock-строке должны быть base64-encoded
      const userRow = {
        uuid: 'aaaa0000-0000-0000-0000-000000000001',
        email_encrypted: Buffer.from('enc@test.com', 'utf8').toString('base64'),
        email_encrypted_bi: 'blind-index-hash',
        full_name: Buffer.from('Ivan Petrov', 'utf8').toString('base64'),
      };

      const mock = createMockExecutor([[userRow]]);
      UserEntity.setExecutor(mock.executor);
      UserEntity.setEncryptionProvider(provider);

      const user = await UserEntity.find({ uuid: userRow.uuid });
      expect(user).not.toBeNull();

      const json = user!.toJSON();
      expect(json).not.toHaveProperty('email_encrypted_bi');
      expect(json).toHaveProperty('email_encrypted');
      expect(json).toHaveProperty('full_name', 'Ivan Petrov');
      expect(json).toHaveProperty('uuid', userRow.uuid);
    });
  });

  describe('entity without encrypted fields (UserRoleEntity)', () => {
    it('returns all fields without filtering', async () => {
      const roleRow = {
        user_uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
        role_uuid: '00000000-0000-0000-0000-000000000002',
        organization_uuid: '00000000-0000-0000-0000-000000000003',
        is_global: true,
      };

      const mock = createMockExecutor([[roleRow]]);
      UserRoleEntity.setExecutor(mock.executor);

      const role = await UserRoleEntity.find({
        user_uuid: roleRow.user_uuid,
        role_uuid: roleRow.role_uuid,
      });
      expect(role).not.toBeNull();

      const json = role!.toJSON();
      expect(json).toEqual({
        user_uuid: roleRow.user_uuid,
        role_uuid: roleRow.role_uuid,
        organization_uuid: roleRow.organization_uuid,
        is_global: true,
      });
    });
  });

  describe('manual instantiation', () => {
    it('works on manually created instances', () => {
      const photo = new PhotoEntity();
      photo.uuid = 'manual-uuid';
      photo.title = 'Manual';
      photo.description = '';
      photo.width = 100;
      photo.height = 100;
      photo.file_size = BigInt(500);
      photo.rating = 1.0;
      photo.is_public = false;
      photo.author_email = 'manual@test.com';
      (photo as any).author_email_bi = 'should-be-excluded';
      photo.like_count = 0;

      const json = photo.toJSON();
      expect(json).not.toHaveProperty('author_email_bi');
      expect(json).toHaveProperty('uuid', 'manual-uuid');
      expect(json).toHaveProperty('title', 'Manual');
      expect(json.author_email).toBe('manual@test.com');
    });
  });
});
