import 'reflect-metadata';
import { UserEntity } from './fixtures/user/user.entity.js';
import { UserRoleEntity } from './fixtures/user_role/user_role.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { Base64TestEncryptionProvider } from '../src/encryption/base64-test-encryption.provider.js';
import { validateYdbModuleOptions } from '../src/core/driver.js';
import { configureEntities } from '../src/core/standalone.js';
import { YdbCoreModule } from '../src/module/ydb-core.module.js';
import { YDB_OPTIONS } from '../src/core/constants.js';
import { YdbEntity, YdbColumn, YdbBaseEntity } from '../src/index.js';

/** Сущность без PK-колонки (ни @YdbPrimaryColumn, ни uuid). */
@YdbEntity('no_pk')
class NoPkEntity extends YdbBaseEntity {
  @YdbColumn('Utf8')
  name!: string;
}

/** Класс-наследник YdbBaseEntity без @YdbEntity. */
class UndecoratedEntity extends YdbBaseEntity {}

const uuid1 = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';

describe('error guards: понятные fail-fast ошибки', () => {
  afterEach(() => {
    UserEntity.setExecutor(undefined as any);
    UserEntity.setEncryptionProvider(undefined as any);
    UserEntity.setBlindIndexProvider(undefined as any);
    UserRoleEntity.setExecutor(undefined as any);
    NoPkEntity.setExecutor(undefined as any);
    UndecoratedEntity.setExecutor(undefined as any);
  });

  describe('YDB executor not set', () => {
    it('подсказывает про YdbModule.forFeature и configureEntities', async () => {
      await expect(UserEntity.find({ uuid: uuid1 })).rejects.toThrow(
        /YDB executor not set for entity UserEntity\. .*YdbModule\.forFeature\(\[UserEntity]\).*configureEntities/s,
      );
    });
  });

  describe('класс без @YdbEntity', () => {
    it('бросает понятную ошибку с подсказкой про декоратор', async () => {
      const mock = createMockExecutor([[]]);
      UndecoratedEntity.setExecutor(mock.executor);

      await expect(UndecoratedEntity.find({ uuid: uuid1 })).rejects.toThrow(
        /Entity UndecoratedEntity is not decorated with @YdbEntity\. .*@YdbColumn/s,
      );
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('провайдеры шифрования', () => {
    it('save() без encryptionProvider — ошибка с подсказкой, как настроить', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      const user = new UserEntity();
      user.full_name = 'Ivan';
      await expect(UserEntity.save(user)).rejects.toThrow(
        /Encryption provider is not configured for entity UserEntity.*encryptionProvider/s,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('save() без blindIndexProvider — ошибка с подсказкой, как настроить', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);
      UserEntity.setEncryptionProvider(new Base64TestEncryptionProvider());

      const user = new UserEntity();
      user.email_encrypted = 'a@b.c';
      await expect(UserEntity.save(user)).rejects.toThrow(
        /Blind index provider is not configured for entity UserEntity.*blindIndexProvider/s,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('поиск по шифрованному полю без blind index — понятная ошибка', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      // full_name: @YdbEncrypted({ blindIndex: false })
      await expect(UserEntity.find({ full_name: 'Ivan' })).rejects.toThrow(
        /Cannot search by encrypted field "full_name" on entity UserEntity.*blindIndex: true/s,
      );
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('неизвестные поля', () => {
    it('find() — ошибка со списком известных полей', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await expect(UserEntity.find({ emial: 'x' })).rejects.toThrow(
        /Unknown field in WHERE: "emial" on entity UserEntity\. Known fields: .*email_encrypted/s,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('find() со строкой в select — ошибка со списком известных полей', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await expect(
        UserEntity.find({ uuid: uuid1 }, { select: ['uuid', 'nope'] }),
      ).rejects.toThrow(
        /Unknown field in select: "nope" on entity UserEntity\. Known fields:/,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('query builder .select() с опечаткой — ошибка со списком полей', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await expect(
        UserEntity.query().select(['nope']).getMany(),
      ).rejects.toThrow(
        /Unknown field in select: "nope" on entity UserEntity\. Known fields:/,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('updateBy() — опечатка в patch со списком известных полей', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await expect(
        UserRoleEntity.updateBy({ user_uuid: uuid1 }, { is_globla: true }),
      ).rejects.toThrow(
        /Unknown field in patch: "is_globla" on entity UserRoleEntity\. Known fields: .*is_global/s,
      );
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('защита от full-table update/delete', () => {
    it('updateBy() с where из одних undefined — отказ', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await expect(
        UserRoleEntity.updateBy({ user_uuid: undefined }, { is_global: true }),
      ).rejects.toThrow(/no effective WHERE condition.*full-table update/);
      expect(mock.queries).toHaveLength(0);
    });

    it('deleteBy() с where из одних undefined — отказ', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await expect(
        UserRoleEntity.deleteBy({ user_uuid: undefined }),
      ).rejects.toThrow(/no effective WHERE condition.*full-table delete/);
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('delete() по PK', () => {
    it('сущность без PK-колонки — понятная ошибка вместо странного SQL', async () => {
      const mock = createMockExecutor([[]]);
      NoPkEntity.setExecutor(mock.executor);

      await expect(NoPkEntity.delete(uuid1)).rejects.toThrow(
        /Cannot delete NoPkEntity by primary key: column "uuid" is not declared.*@YdbPrimaryColumn/s,
      );
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('loadRelations()', () => {
    it('неизвестный relation — ошибка со списком известных', async () => {
      const user = new UserEntity();
      user.uuid = uuid1;

      await expect(user.loadRelations(['nope'])).rejects.toThrow(
        /Unknown relation: "nope" on entity UserEntity\. Known relations: userRoles/s,
      );
    });
  });

  describe('configureEntities()', () => {
    it('без executor — понятная ошибка', () => {
      expect(() => configureEntities([UserRoleEntity], {} as any)).toThrow(
        /configureEntities\(\) requires "options\.executor"/,
      );
    });

    it('не-сущность в массиве — понятная ошибка', () => {
      const mock = createMockExecutor();
      class NotAnEntity {}
      expect(() =>
        configureEntities([NotAnEntity as any], { executor: mock.executor }),
      ).toThrow(/NotAnEntity is not a YdbBaseEntity subclass/);
    });
  });

  describe('validateYdbModuleOptions()', () => {
    it('без endpoint — понятная ошибка', () => {
      expect(() => validateYdbModuleOptions({} as any)).toThrow(
        /"endpoint" is required/,
      );
    });

    it('auth_key без authorized_key_path — понятная ошибка', () => {
      expect(() =>
        validateYdbModuleOptions({
          endpoint: 'grpcs://example:2135/db',
          auth_type: 'auth_key',
          authOptions: {},
        }),
      ).toThrow(/authOptions\.authorized_key_path.*auth_key/);
    });

    it('валидные опции проходят', () => {
      expect(() =>
        validateYdbModuleOptions({
          endpoint: 'grpcs://example:2135/db',
          auth_type: 'anonymous',
          authOptions: {},
        }),
      ).not.toThrow();
    });

    it('YdbCoreModule.forRootAsync валидирует результат useFactory', async () => {
      const dynamicModule = YdbCoreModule.forRootAsync({
        useFactory: () => ({}) as any,
      });
      const optionsProvider = (dynamicModule.providers as any[]).find(
        (p) => p.provide === YDB_OPTIONS,
      );
      await expect(optionsProvider.useFactory()).rejects.toThrow(
        /"endpoint" is required/,
      );
    });
  });
});
