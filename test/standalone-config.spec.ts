import 'reflect-metadata';
import { describe, it, expect } from '@jest/globals';
import {
  YdbEntity,
  YdbColumn,
  YdbBaseEntity,
  Base64TestEncryptionProvider,
} from '../src/index.js';
import { configureEntities } from '../src/core/standalone.js';
import { createMockExecutor } from './helpers/mock-executor.js';

@YdbEntity('test_users')
class TestUser extends YdbBaseEntity {
  @YdbColumn('Utf8')
  name!: string;
}

@YdbEntity('test_posts')
class TestPost extends YdbBaseEntity {
  @YdbColumn('Utf8')
  title!: string;
}

@YdbEntity('test_simple')
class TestSimple extends YdbBaseEntity {
  @YdbColumn('Utf8')
  value!: string;
}

describe('configureEntities', () => {
  it('устанавливает executor на все сущности', () => {
    const { executor } = createMockExecutor();
    configureEntities([TestUser, TestPost], { executor });

    // Если executor установлен, getExecutor() не бросит ошибку
    expect(() => (TestUser as any).getExecutor()).not.toThrow();
    expect(() => (TestPost as any).getExecutor()).not.toThrow();
  });

  it('устанавливает encryptionProvider и blindIndexProvider если переданы', () => {
    const { executor } = createMockExecutor();
    const encryptionProvider = new Base64TestEncryptionProvider();
    const blindIndexProvider = {
      hash: (value: string) => Promise.resolve(`idx_${value}`),
    };

    configureEntities([TestUser], {
      executor,
      encryptionProvider,
      blindIndexProvider,
    });

    expect((TestUser as any).getEncryptionProvider()).toBe(encryptionProvider);
    expect((TestUser as any).getBlindIndexProvider()).toBe(blindIndexProvider);
  });

  it('работает без опциональных провайдеров', () => {
    const { executor } = createMockExecutor();
    configureEntities([TestSimple], { executor });

    expect((TestSimple as any).getEncryptionProvider()).toBeUndefined();
    expect((TestSimple as any).getBlindIndexProvider()).toBeUndefined();
  });

  it('устанавливает executor на пустом массиве сущностей без ошибок', () => {
    const { executor } = createMockExecutor();
    expect(() => configureEntities([], { executor })).not.toThrow();
  });
});
