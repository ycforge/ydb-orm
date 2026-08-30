import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { createAuth } from '@ycforge/auth';
import {
  YdbCoreModule,
  YdbOrmModule,
  YDB_DRIVER,
  YDB_QUERY,
  YdbEncryptionProvider,
  YdbBlindIndexProvider,
  YdbBaseEntity,
  YdbEntity,
  YdbPrimaryColumn,
  YdbColumn,
} from '../../src/nest/index.js';
import { PhotoEntity } from '../fixtures/photo/photo.entity.js';
import { createActiveRecordEntityProvider } from '../../src/nest/repository-factory.js';
import { getEntityRuntime } from '../../src/entity/entity-runtime.js';
import { createMockExecutor, MockExecutor } from '../helpers/mock-executor.js';
import type { YdbOrmScope } from '../../src/nest/index.js';
import { createOrmScope, getEntityOrmScope } from '../../src/nest/index.js';

@Module({
  imports: [YdbOrmModule.forFeature([PhotoEntity])],
})
class TestFeatureModule {}

/** Сущность без шифрованных полей — для проверки сброса на уровне фабрики. */
@YdbEntity('reset_plain')
class ResetPlain extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;
}

/** Тегированные заглушки провайдеров: по значению видно, кто использован. */
function makeTaggedProviders(tag: string): {
  encryptionProvider: YdbEncryptionProvider;
  blindIndexProvider: YdbBlindIndexProvider;
} {
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

async function bootstrap(
  providers: {
    encryptionProvider?: YdbEncryptionProvider;
    blindIndexProvider?: YdbBlindIndexProvider;
  },
  rows: any[][] = [[]],
): Promise<{ mock: MockExecutor; close: () => Promise<void> }> {
  const mock = createMockExecutor(rows);
  const module = await Test.createTestingModule({
    imports: [
      YdbCoreModule.forRootAsync({
        useFactory: () => ({
          endpoint: 'grpc://localhost:2136/local',
          auth: createAuth({ type: 'anonymous' }),
          ...providers,
        }),
      }),
      TestFeatureModule,
    ],
  })
    .overrideProvider(YDB_DRIVER)
    .useValue({})
    .overrideProvider(YDB_QUERY)
    .useValue(mock.executor)
    .compile();

  return { mock, close: () => module.close() };
}

describe('NestJS integration: сброс провайдеров при повторном бутстрапе', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    // Чистим runtime-состояние сущностей между тестами
    for (const e of [PhotoEntity, ResetPlain]) {
      e.setExecutor(undefined);
      e.setEncryptionProvider(undefined);
      e.setBlindIndexProvider(undefined);
    }
  });

  it('повторный бутстрап подменяет провайдеры новыми', async () => {
    const first = await bootstrap(makeTaggedProviders('A'));
    cleanup = first.close;
    await first.close();

    const second = await bootstrap(makeTaggedProviders('B'));
    cleanup = second.close;

    const photo = new PhotoEntity();
    photo.title = 'Sunset';
    photo.author_email = 'a@b.c';
    await PhotoEntity.save(photo);

    // Использованы новые провайдеры, а не оставшиеся от прошлого бутстрапа
    const [upsert] = second.mock.queries;
    expect((upsert.params.author_email as any).value).toEqual(
      new TextEncoder().encode('enc:B'),
    );
    expect((upsert.params.author_email_bi as any).value).toBe('bi:B:a@b.c');
  });

  it('бутстрап без провайдеров не проходит молча: валидация называет сущность', async () => {
    const first = await bootstrap(makeTaggedProviders('A'));
    cleanup = first.close;
    await first.close();

    // У PhotoEntity есть @YdbEncrypted поля — бутстрап без encryptionProvider
    // обязан упасть с понятной ошибкой, а не оставить прошлые провайдеры.
    await expect(bootstrap({})).rejects.toThrow(
      /PhotoEntity[\s\S]*metadata validation failed[\s\S]*no encryptionProvider is configured/,
    );
  });

  it('createActiveRecordEntityProvider: повторный вызов без провайдеров сбрасывает их', () => {
    const provider = createActiveRecordEntityProvider(ResetPlain);
    const useFactory = (
      provider as unknown as {
        useFactory: (
          db: any,
          opts: any,
          encryptionProvider?: YdbEncryptionProvider,
          blindIndexProvider?: YdbBlindIndexProvider,
        ) => unknown;
      }
    ).useFactory;
    const opts = {
      endpoint: 'grpc://localhost:2136/local',
      auth: createAuth({ type: 'anonymous' }),
    };
    const db = createMockExecutor().executor;
    const { encryptionProvider, blindIndexProvider } = makeTaggedProviders('A');

    useFactory(db, opts, encryptionProvider, blindIndexProvider);
    expect(getEntityRuntime(ResetPlain).encryptionProvider).toBe(
      encryptionProvider,
    );
    expect(getEntityRuntime(ResetPlain).blindIndexProvider).toBe(
      blindIndexProvider,
    );

    // Повторная инициализация без провайдеров — явный сброс в undefined
    useFactory(db, opts, undefined, undefined);
    expect(getEntityRuntime(ResetPlain).encryptionProvider).toBeUndefined();
    expect(getEntityRuntime(ResetPlain).blindIndexProvider).toBeUndefined();
  });

  it('createActiveRecordEntityProvider: сбой конфигурации откатывает ранее сконфигурированную сущность (#200)', () => {
    const provider = createActiveRecordEntityProvider(ResetPlain);
    const useFactory = (
      provider as unknown as {
        useFactory: (
          db: any,
          opts: any,
          encryptionProvider?: YdbEncryptionProvider,
          blindIndexProvider?: YdbBlindIndexProvider,
          _validationProvider?: unknown,
          _entityAppScope?: unknown,
          ormScope?: YdbOrmScope,
        ) => unknown;
      }
    ).useFactory;

    const opts = {
      endpoint: 'grpc://localhost:2136/local',
      auth: createAuth({ type: 'anonymous' }),
      uuidVersion: 'v4' as const,
    };
    const scope = createOrmScope('factory-rollback-scope', {
      transactions: { ambient: true },
    });
    const firstDb = createMockExecutor().executor;
    const secondDb = createMockExecutor().executor;
    const { encryptionProvider, blindIndexProvider } = makeTaggedProviders('A');

    // 1. Успешная конфигурация — сущность уже настроена до падающего вызова.
    useFactory(
      firstDb,
      opts,
      encryptionProvider,
      blindIndexProvider,
      undefined,
      undefined,
      scope,
    );

    const before = getEntityRuntime(ResetPlain);
    const repositoryBefore = before.repository;
    expect(repositoryBefore).toBeDefined();
    expect(before.scope).toBe(scope);

    // 2. Вторая конфигурация мутирует runtime (новый executor, uuid v7,
    //    провайдеры обнуляются, repository пересоздаётся), затем падает.
    const setExecutorSpy = jest.spyOn(ResetPlain, 'setExecutor');
    setExecutorSpy.mockImplementationOnce(() => {
      throw new Error('simulated configuration failure');
    });

    try {
      expect(() =>
        useFactory(
          secondDb,
          opts,
          undefined,
          undefined,
          undefined,
          undefined,
          scope,
        ),
      ).toThrow('simulated configuration failure');
    } finally {
      setExecutorSpy.mockRestore();
    }

    // 3. Runtime восстановлен ТОЧНО к прежнему состоянию — по ссылкам.
    const after = getEntityRuntime(ResetPlain);
    expect(after.executor).toBe(firstDb);
    expect(after.encryptionProvider).toBe(encryptionProvider);
    expect(after.blindIndexProvider).toBe(blindIndexProvider);
    expect(after.uuidGenerator).toBe(before.uuidGenerator);
    expect(after.scope).toBe(scope);
    expect(after.transactions).toBe(scope.transactions);
    expect(after.repository).toBe(repositoryBefore);

    // 4. Владение не изменилось: сущность осталась за своим скоупом.
    expect(getEntityOrmScope(ResetPlain)).toBe(scope);
  });
});
