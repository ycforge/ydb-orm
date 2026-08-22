import 'reflect-metadata';
import { describe, it, expect, afterEach } from '@jest/globals';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEncrypted,
} from '../src/index.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import { configureEntities } from '../src/core/standalone.js';
import { getEntityRuntime } from '../src/entity/entity-runtime.js';
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

/** Класс-наследник YdbBaseEntity без @YdbEntity. */
class UndecoratedStandalone extends YdbBaseEntity {}

/** Сущность без PK — метаданные невалидны. */
@YdbEntity('test_no_pk')
class NoPkStandalone extends YdbBaseEntity {
  @YdbColumn('Utf8')
  name!: string;
}

/** Тегированные заглушки провайдеров: по значению видно, кто использован. */
function makeTaggedProviders(tag: string) {
  return {
    encryptionProvider: {
      encrypt: (_plaintext: string) =>
        Promise.resolve(new TextEncoder().encode(`enc:${tag}`)),
      decrypt: (ciphertext: Uint8Array) =>
        Promise.resolve(
          new TextDecoder().decode(ciphertext).replace(/^enc:/, ''),
        ),
    },
    blindIndexProvider: {
      hash: (plaintext: string) => Promise.resolve(`bi:${tag}:${plaintext}`),
    },
  };
}

describe('configureEntities', () => {
  afterEach(() => {
    // Чистим runtime-состояние между тестами: сущности глобальны для файла.
    for (const e of [
      TestUser,
      TestPost,
      TestSimple,
      TestEncrypted,
      UndecoratedStandalone,
      NoPkStandalone,
    ]) {
      e.setExecutor(undefined);
      e.setEncryptionProvider(undefined);
      e.setBlindIndexProvider(undefined);
    }
  });

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

  // ---- uuidVersion (#108) ----

  it('по умолчанию генерирует UUID v7', async () => {
    const mock = createMockExecutor([[]]);
    configureEntities([TestSimple], { executor: mock.executor });

    await TestSimple.save(Object.assign(new TestSimple(), { value: 'x' }));

    const generated = String(mock.queries[0].params.uuid);
    expect(generated[14]).toBe('7');
  });

  it('генерирует UUID v4 при uuidVersion: "v4"', async () => {
    const mock = createMockExecutor([[]]);
    configureEntities([TestSimple], {
      executor: mock.executor,
      uuidVersion: 'v4',
    });

    await TestSimple.save(Object.assign(new TestSimple(), { value: 'x' }));

    const generated = String(mock.queries[0].params.uuid);
    expect(generated[14]).toBe('4');
  });

  // ---- сброс провайдеров при повторном бутстрапе (#108) ----

  it('повторный бутстрап шифрованной сущности без провайдеров падает громко', () => {
    const mock = createMockExecutor([[]]);

    configureEntities([TestEncrypted], {
      executor: mock.executor,
      ...makeTaggedProviders('A'),
    });

    // Повторный бутстрап без провайдеров отклоняется валидацией с именем
    // сущности — провайдеры прошлой конфигурации не переживают его молча.
    expect(() =>
      configureEntities([TestEncrypted], { executor: mock.executor }),
    ).toThrow(
      /configureEntities\(\)[\s\S]*TestEncrypted[\s\S]*no encryptionProvider is configured/,
    );
    expect(mock.queries).toHaveLength(0);
  });

  it('повторный бутстрап сбрасывает прошлые провайдеры у обычной сущности', () => {
    const mock = createMockExecutor([[]]);
    const { encryptionProvider, blindIndexProvider } = makeTaggedProviders('A');

    // Провайдеры остались от прошлой конфигурации
    TestSimple.setExecutor(mock.executor);
    TestSimple.setEncryptionProvider(encryptionProvider);
    TestSimple.setBlindIndexProvider(blindIndexProvider);

    // Повторный бутстрап без провайдеров — явный сброс, а не «молча остались»
    configureEntities([TestSimple], { executor: mock.executor });

    expect(getEntityRuntime(TestSimple).encryptionProvider).toBeUndefined();
    expect(getEntityRuntime(TestSimple).blindIndexProvider).toBeUndefined();
  });

  it('повторный бутстрап подменяет executor и провайдеры на новые', async () => {
    const first = createMockExecutor([[]]);
    const second = createMockExecutor([[]]);

    configureEntities([TestEncrypted], {
      executor: first.executor,
      ...makeTaggedProviders('A'),
    });
    configureEntities([TestEncrypted], {
      executor: second.executor,
      ...makeTaggedProviders('B'),
    });

    const e = new TestEncrypted();
    e.secret = 'hello';
    await TestEncrypted.save(e);

    // Executor старой конфигурации больше не используется
    expect(first.queries).toHaveLength(0);
    expect(second.queries).toHaveLength(1);

    // Использованы новые провайдеры, а не оставшиеся от прошлого бутстрапа
    const [upsert] = second.queries;
    expect((upsert.params.secret as any).value).toEqual(
      new TextEncoder().encode('enc:B'),
    );
    expect((upsert.params.secret_bi as any).value).toBe('bi:B:hello');
  });

  // ---- валидация метаданных перед регистрацией (#108) ----

  it('класс без @YdbEntity — понятная ошибка с именем класса', () => {
    const { executor } = createMockExecutor();

    expect(() =>
      configureEntities([UndecoratedStandalone], { executor }),
    ).toThrow(
      /configureEntities\(\)[\s\S]*UndecoratedStandalone[\s\S]*is not decorated with @YdbEntity/,
    );
  });

  it('невалидная сущность — ошибка с именем сущности и списком проблем', () => {
    const { executor } = createMockExecutor();

    expect(() => configureEntities([NoPkStandalone], { executor })).toThrow(
      /configureEntities\(\)[\s\S]*NoPkStandalone[\s\S]*must declare at least one primary key/,
    );
  });

  it('валидирует все сущности до применения конфигурации (без частичной настройки)', async () => {
    const { executor } = createMockExecutor();

    @YdbEntity('test_atomic_valid')
    class AtomicValid extends YdbBaseEntity {
      @YdbPrimaryColumn('Uuid')
      uuid!: string;
    }

    expect(() =>
      configureEntities([AtomicValid, UndecoratedStandalone], { executor }),
    ).toThrow(/UndecoratedStandalone/);

    // Валидная соседняя сущность тоже не сконфигурирована
    await expect(AtomicValid.findAll()).rejects.toThrow(/YDB executor not set/);
  });
});
