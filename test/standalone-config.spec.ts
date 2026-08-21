import 'reflect-metadata';
import { describe, it, expect } from '@jest/globals';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEncrypted,
} from '../src/index.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import { configureEntities } from '../src/core/standalone.js';
import { createMockExecutor } from './helpers/mock-executor.js';

@YdbEntity('test_users')
class TestUser extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;
}

@YdbEntity('test_posts')
class TestPost extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  title!: string;
}

@YdbEntity('test_simple')
class TestSimple extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  value!: string;
}

@YdbEntity('test_encrypted')
class TestEncrypted extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbEncrypted({ blindIndex: true })
  secret?: string;
}

describe('configureEntities', () => {
  it('устанавливает executor на все сущности', async () => {
    const { executor } = createMockExecutor();
    configureEntities([TestUser, TestPost], { executor });

    // Если executor установлен, findAll() не бросит ошибку и вернёт пустой массив
    await expect(TestUser.findAll()).resolves.toEqual([]);
    await expect(TestPost.findAll()).resolves.toEqual([]);
  });

  it('устанавливает encryptionProvider и blindIndexProvider если переданы', async () => {
    const provider = new TestOnlyEncryptionProvider();
    const mock = createMockExecutor([[]]);

    configureEntities([TestEncrypted], {
      executor: mock.executor,
      encryptionProvider: provider,
      blindIndexProvider: provider,
    });

    const e = new TestEncrypted();
    e.secret = 'hello';
    await TestEncrypted.save(e);

    const [saveQ] = mock.queries;
    expect(saveQ.sql).toContain('UPSERT INTO `test_encrypted`');
    expect(saveQ.params.secret).toBeDefined();
    expect(saveQ.params.secret_bi).toBeDefined();
  });

  it('работает без опциональных провайдеров', async () => {
    const { executor } = createMockExecutor();
    configureEntities([TestSimple], { executor });

    await expect(TestSimple.findAll()).resolves.toEqual([]);
  });

  it('устанавливает executor на пустом массиве сущностей без ошибок', () => {
    const { executor } = createMockExecutor();
    expect(() => configureEntities([], { executor })).not.toThrow();
  });
});
