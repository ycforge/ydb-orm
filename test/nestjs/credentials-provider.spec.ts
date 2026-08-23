import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { CredentialsProvider } from '@ydbjs/auth';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';
import {
  YdbCoreModule,
  YDB_CREDENTIALS_PROVIDER,
  YDB_DRIVER,
  YDB_QUERY,
  type YdbModuleOptions,
  type YdbOptionsFactory,
} from '../../src/index.js';
import type { TestingModule } from '@nestjs/testing';
import { createMockExecutor } from '../helpers/mock-executor.js';

/**
 * Регрессионные тесты #96: кастомный CredentialsProvider в опциях модуля.
 *
 * Сеть не используется: драйвер и executor подменяются через overrideProvider.
 * Тот факт, что провайдер доходит до createDriver, покрывается юнит-спекой
 * src/core/driver.spec.ts (заглушка Driver фиксирует аргументы конструктора);
 * здесь проверяется DI-обвязка модуля: токен YDB_CREDENTIALS_PROVIDER
 * разрешается ровно в настроенный провайдер — именно он инжектируется
 * фабрикой YDB_DRIVER в createDriver().
 */

/** Тестовая реализация провайдера с маркером. */
class TaggedCredentialsProvider extends CredentialsProvider {
  constructor(private readonly tag: string) {
    super();
  }
  getToken(): Promise<string> {
    return Promise.resolve(`token:${this.tag}`);
  }
}

/** useExisting-паттерн: готовая конфигурация, отдающая опции модуля. */
class TaggedCredentialsConfig implements YdbOptionsFactory {
  constructor(private readonly provider: CredentialsProvider) {}
  createYdbOptions(): YdbModuleOptions {
    return {
      endpoint: 'grpc://localhost:2136/local',
      auth_type: 'anonymous',
      authOptions: {},
      credentialsProvider: this.provider,
      sync: false,
    };
  }
}

@Module({
  providers: [TaggedCredentialsConfig],
  exports: [TaggedCredentialsConfig],
})
class ConfigHolderModule {}

async function bootstrapWithOptions(
  options: Partial<YdbModuleOptions>,
): Promise<{ moduleRef: TestingModule; close: () => Promise<void> }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      YdbCoreModule.forRootAsync({
        useFactory: () => ({
          endpoint: 'grpc://localhost:2136/local',
          auth_type: 'anonymous' as const,
          authOptions: {},
          sync: false as const,
          ...options,
        }),
      }),
    ],
  })
    .overrideProvider(YDB_DRIVER)
    .useValue({})
    .overrideProvider(YDB_QUERY)
    .useValue(createMockExecutor().executor)
    .compile();

  return { moduleRef, close: () => moduleRef.close() };
}

async function bootstrapUseExisting(
  provider: CredentialsProvider,
): Promise<{ moduleRef: TestingModule; close: () => Promise<void> }> {
  const config = new TaggedCredentialsConfig(provider);
  const moduleRef = await Test.createTestingModule({
    imports: [
      // Класс-фабрика предоставляется своим модулем (паттерн useExisting):
      // ядро инжектирует уже существующий экземпляр и вызывает createYdbOptions().
      // Модуль с классом-фабрикой передаётся в imports ядра, чтобы
      // TaggedCredentialsConfig был виден провайдерам YdbCoreModule.
      YdbCoreModule.forRootAsync({
        useExisting: TaggedCredentialsConfig,
        imports: [ConfigHolderModule],
      }),
    ],
  })
    .overrideProvider(TaggedCredentialsConfig)
    .useValue(config)
    .overrideProvider(YDB_DRIVER)
    .useValue({})
    .overrideProvider(YDB_QUERY)
    .useValue(createMockExecutor().executor)
    .compile();

  return { moduleRef, close: () => moduleRef.close() };
}

describe('NestJS integration: кастомный CredentialsProvider (#96)', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('useFactory: кастомный провайдер резолвится из токена YDB_CREDENTIALS_PROVIDER', async () => {
    const custom = new TaggedCredentialsProvider('factory');
    const boot = await bootstrapWithOptions({ credentialsProvider: custom });
    cleanup = boot.close;

    expect(boot.moduleRef.get(YDB_CREDENTIALS_PROVIDER)).toBe(custom);
  });

  it('useExisting: провайдер из готовой конфигурации попадает в DI', async () => {
    const custom = new TaggedCredentialsProvider('existing');
    const boot = await bootstrapUseExisting(custom);
    cleanup = boot.close;

    expect(boot.moduleRef.get(YDB_CREDENTIALS_PROVIDER)).toBe(custom);
  });

  it('конфликт credentialsProvider и driverOptions.credentialsProvider — понятная ошибка компиляции', async () => {
    await expect(
      bootstrapWithOptions({
        credentialsProvider: new TaggedCredentialsProvider('custom'),
        driverOptions: {
          credentialsProvider: new TaggedCredentialsProvider('low-level'),
        },
      }),
    ).rejects.toThrow(/Conflicting YDB credentials configuration/);
  });

  it('без кастомного провайдера поведение по умолчанию не изменилось (auth_type=anonymous)', async () => {
    const boot = await bootstrapWithOptions({});
    cleanup = boot.close;

    expect(boot.moduleRef.get(YDB_CREDENTIALS_PROVIDER)).toBeInstanceOf(
      AnonymousCredentialsProvider,
    );
  });

  it('повторный бутстрап подменяет провайдер; сброс возвращает дефолт по auth_type', async () => {
    const first = new TaggedCredentialsProvider('A');
    const firstBoot = await bootstrapWithOptions({
      credentialsProvider: first,
    });
    cleanup = firstBoot.close;
    expect(firstBoot.moduleRef.get(YDB_CREDENTIALS_PROVIDER)).toBe(first);
    await firstBoot.close();

    const second = new TaggedCredentialsProvider('B');
    const secondBoot = await bootstrapWithOptions({
      credentialsProvider: second,
    });
    cleanup = secondBoot.close;
    // Провайдер прошлого бутстрапа не «протекает»: токен указывает на новый.
    expect(secondBoot.moduleRef.get(YDB_CREDENTIALS_PROVIDER)).toBe(second);
    await secondBoot.close();

    // Бутстрап без кастомного провайдера: свежий дефолт по auth_type,
    // а не оставшийся экземпляр прошлой конфигурации (#108/#95).
    const defaultBoot = await bootstrapWithOptions({});
    cleanup = defaultBoot.close;
    const resolved = defaultBoot.moduleRef.get(YDB_CREDENTIALS_PROVIDER);
    expect(resolved).not.toBe(first);
    expect(resolved).not.toBe(second);
    expect(resolved).toBeInstanceOf(AnonymousCredentialsProvider);
  });
});
