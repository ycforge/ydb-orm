import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { jest } from '@jest/globals';
import {
  YdbCoreModule,
  YdbModule,
  YDB_DRIVER,
  YDB_QUERY,
  YDB_VALIDATION_PROVIDER,
  YdbBaseEntity,
  YdbEntity,
  YdbPrimaryColumn,
  YdbColumn,
} from '../../src/index.js';
import type { YdbValidationProvider } from '../../src/index.js';
import { getEntityRuntime } from '../../src/entity/entity-runtime.js';
import { createMockExecutor, MockExecutor } from '../helpers/mock-executor.js';

@YdbEntity('validation_plain')
class ValidationPlain extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;
}

@Module({
  imports: [YdbModule.forFeature([ValidationPlain])],
})
class TestFeatureModule {}

const PK = '00000000-0000-4000-8000-000000000001';

/** Тегированный validation-провайдер: по сообщению видно, кто использован. */
function makeTaggedValidationProvider(tag: string) {
  const validateFn = jest.fn((entity: any) =>
    Promise.resolve(
      entity.name === 'bad'
        ? [
            {
              property: 'name',
              constraint: 'isNotEmpty',
              message: `invalid:${tag}`,
            },
          ]
        : [],
    ),
  );
  const provider: YdbValidationProvider = { validate: validateFn };
  return { provider, validateFn };
}

async function bootstrap(
  options: { validationProvider?: YdbValidationProvider } = {},
  rows: any[][] = [[]],
): Promise<{
  mock: MockExecutor;
  close: () => Promise<void>;
  getTokenValue: () => unknown;
}> {
  const mock = createMockExecutor(rows);
  const moduleRef = await Test.createTestingModule({
    imports: [
      YdbCoreModule.forRootAsync({
        useFactory: () => ({
          endpoint: 'grpc://localhost:2136/local',
          auth_type: 'anonymous' as const,
          authOptions: {},
          ...options,
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

  return {
    mock,
    close: () => moduleRef.close(),
    // DI-токен экспортируется корневым модулем и резолвится в провайдер из опций
    getTokenValue: () => moduleRef.get(YDB_VALIDATION_PROVIDER),
  };
}

describe('NestJS integration: validationProvider (#95)', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    ValidationPlain.setExecutor(undefined);
    ValidationPlain.setEncryptionProvider(undefined);
    ValidationPlain.setBlindIndexProvider(undefined);
    ValidationPlain.setValidationProvider(undefined);
  });

  it('validationProvider из опций доступен по DI-токену и подключён к сущности', async () => {
    const { provider, validateFn } = makeTaggedValidationProvider('A');
    const boot = await bootstrap({ validationProvider: provider });
    cleanup = boot.close;

    expect(boot.getTokenValue()).toBe(provider);
    expect(getEntityRuntime(ValidationPlain).validationProvider).toBe(provider);

    // Active Record save() идёт через прокинутый провайдер
    const bad = Object.assign(new ValidationPlain(), {
      uuid: PK,
      name: 'bad',
    });
    await expect(ValidationPlain.save(bad)).rejects.toThrow(
      /Validation failed for ValidationPlain: name: invalid:A \[isNotEmpty\]/,
    );
    expect(validateFn).toHaveBeenCalledTimes(1);
  });

  it('валидная сущность сохраняется через прокинутый провайдер', async () => {
    const { provider, validateFn } = makeTaggedValidationProvider('A');
    // UPDATE ... RETURNING * — мок возвращает строку результата
    const boot = await bootstrap({ validationProvider: provider }, [
      [{ uuid: PK, name: 'ok' }],
    ]);
    cleanup = boot.close;

    const good = Object.assign(new ValidationPlain(), {
      uuid: PK,
      name: 'ok',
    });
    const saved = await ValidationPlain.save(good);
    expect(saved).toBeInstanceOf(ValidationPlain);
    expect(validateFn).toHaveBeenCalledTimes(1);
    expect(boot.mock.queries[0].sql).toContain('UPDATE `validation_plain`');
  });

  it('повторный бутстрап подменяет validationProvider новым', async () => {
    const first = makeTaggedValidationProvider('A');
    const second = makeTaggedValidationProvider('B');

    const bootA = await bootstrap({ validationProvider: first.provider });
    await bootA.close();

    const bootB = await bootstrap({ validationProvider: second.provider });
    cleanup = bootB.close;

    expect(getEntityRuntime(ValidationPlain).validationProvider).toBe(
      second.provider,
    );

    const bad = Object.assign(new ValidationPlain(), {
      uuid: PK,
      name: 'bad',
    });
    await expect(ValidationPlain.save(bad)).rejects.toThrow(/invalid:B/);

    // Провайдер из первого бутстрапа больше не используется
    expect(first.validateFn).not.toHaveBeenCalled();
    expect(second.validateFn).toHaveBeenCalledTimes(1);
  });

  it('повторный бутстрап без validationProvider сбрасывает прошлый', async () => {
    const first = makeTaggedValidationProvider('A');

    const bootA = await bootstrap({ validationProvider: first.provider });
    await bootA.close();

    // Бутстрап без провайдера валидации не оставляет прошлый молча
    const bootB = await bootstrap({}, [[{ uuid: PK, name: 'bad' }]]);
    cleanup = bootB.close;

    expect(
      getEntityRuntime(ValidationPlain).validationProvider,
    ).toBeUndefined();

    const bad = Object.assign(new ValidationPlain(), {
      uuid: PK,
      name: 'bad',
    });
    const saved = await ValidationPlain.save(bad);
    expect(saved).toBeInstanceOf(ValidationPlain);
    expect(first.validateFn).not.toHaveBeenCalled();
    expect(bootB.mock.queries).toHaveLength(1);
  });
});
