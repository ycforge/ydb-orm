import 'reflect-metadata';
import { jest } from '@jest/globals';
import { UserEntity } from './fixtures/user/user.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import type { YdbValidationProvider } from '../src/index.js';

function setupEncryption() {
  const provider = new TestOnlyEncryptionProvider();
  UserEntity.setEncryptionProvider(provider);
  UserEntity.setBlindIndexProvider(provider);
}

function setupMock(rows: any[][] = [[]]) {
  const mock = createMockExecutor(rows);
  UserEntity.setExecutor(mock.executor);
  return mock;
}

describe('YdbValidate — валидация перед записью', () => {
  afterEach(() => {
    UserEntity.setExecutor(undefined as any);
    UserEntity.setEncryptionProvider(undefined as any);
    UserEntity.setBlindIndexProvider(undefined as any);
    UserEntity.setValidationProvider(undefined as any);
  });

  describe('без validationProvider — обратная совместимость', () => {
    it('insert работает без провайдера валидации', async () => {
      setupEncryption();
      setupMock();

      const user = new UserEntity();
      user.full_name = 'No Validation';

      await UserEntity.save(user);
      expect(user.uuid).toBeDefined();
    });
  });

  describe('с mock провайдером', () => {
    it('insert вызывает validate и выбрасывает ошибки', async () => {
      setupEncryption();
      setupMock();

      const validateFn = jest.fn(() => Promise.resolve(['email is required']));
      const mockProvider: YdbValidationProvider = { validate: validateFn };
      UserEntity.setValidationProvider(mockProvider);

      const user = new UserEntity();
      user.full_name = 'Should Fail';

      await expect(UserEntity.save(user)).rejects.toThrow(
        /Validation failed for UserEntity: email is required/,
      );
      expect(validateFn).toHaveBeenCalledTimes(1);
    });

    it('insert проходит когда validate возвращает пустой массив', async () => {
      setupEncryption();
      setupMock();

      const validateFn = jest.fn(() => Promise.resolve<string[]>([]));
      const mockProvider: YdbValidationProvider = { validate: validateFn };
      UserEntity.setValidationProvider(mockProvider);

      const user = new UserEntity();
      user.full_name = 'Valid User';

      await UserEntity.save(user);
      expect(user.uuid).toBeDefined();
      expect(validateFn).toHaveBeenCalledTimes(1);
    });

    it('update вызывает validate и выбрасывает ошибки', async () => {
      setupEncryption();
      const updatedRow = {
        uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
        email_encrypted: new TextEncoder().encode('enc'),
        full_name: new TextEncoder().encode('Updated'),
      };
      setupMock([[updatedRow]]);

      const validateFn = jest.fn(() => Promise.resolve(['name too short']));
      const mockProvider: YdbValidationProvider = { validate: validateFn };
      UserEntity.setValidationProvider(mockProvider);

      const user = new UserEntity();
      user.uuid = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';
      user.full_name = 'X';

      await expect(UserEntity.save(user)).rejects.toThrow(
        /Validation failed for UserEntity: name too short/,
      );
      expect(validateFn).toHaveBeenCalledTimes(1);
    });

    it('insertMany вызывает validate для каждой сущности', async () => {
      setupEncryption();
      setupMock();

      const errors: string[] = [];
      const validateFn = jest.fn((entity: any) => {
        if (!entity.full_name) {
          errors.push('full_name is required');
          return Promise.resolve(errors);
        }
        return Promise.resolve<string[]>([]);
      });
      const mockProvider: YdbValidationProvider = { validate: validateFn };
      UserEntity.setValidationProvider(mockProvider);

      const valid = new UserEntity();
      valid.full_name = 'Valid';
      const invalid = new UserEntity();
      // full_name не задан

      await expect(UserEntity.insertMany([valid, invalid])).rejects.toThrow(
        /Validation failed for UserEntity/,
      );
      expect(validateFn).toHaveBeenCalledTimes(2);
    });

    it('insertMany проходит когда все сущности валидны', async () => {
      setupEncryption();
      setupMock();

      const validateFn = jest.fn(() => Promise.resolve<string[]>([]));
      const mockProvider: YdbValidationProvider = { validate: validateFn };
      UserEntity.setValidationProvider(mockProvider);

      const entities = Array.from({ length: 3 }, () => {
        const e = new UserEntity();
        e.full_name = 'Ok';
        return e;
      });

      await UserEntity.insertMany(entities);
      expect(validateFn).toHaveBeenCalledTimes(3);
      for (const e of entities) {
        expect(e.uuid).toBeDefined();
      }
    });

    it('setValidationProvider(undefined) отключает валидацию', async () => {
      setupEncryption();
      setupMock();

      const validateFn = jest.fn(() =>
        Promise.resolve(['should not be called']),
      );
      const mockProvider: YdbValidationProvider = { validate: validateFn };
      UserEntity.setValidationProvider(mockProvider);
      UserEntity.setValidationProvider(undefined as any);

      const user = new UserEntity();
      user.full_name = 'No Validation';

      await UserEntity.save(user);
      expect(user.uuid).toBeDefined();
      expect(validateFn).not.toHaveBeenCalled();
    });
  });
});
