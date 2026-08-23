import 'reflect-metadata';
import {
  jest,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { YdbValidationErrorItem } from '../src/index.js';

/**
 * class-validator — опциональный peer dependency и в dev-окружении не
 * установлен: подменяем загрузчик peer-пакетов фейковой реализацией
 * validate(), фиксирующей переданные опции.
 */
const validateCalls: {
  object: unknown;
  options?: Record<string, unknown>;
}[] = [];
let validateResult: any[] = [];

function fakeValidate(object: object, options?: Record<string, unknown>) {
  validateCalls.push({ object, options });
  return Promise.resolve(validateResult);
}

jest.unstable_mockModule('../src/core/optional-peer.js', () => ({
  loadOptionalPeer: () => Promise.resolve({ validate: fakeValidate }),
}));

let ClassValidatorProvider: (typeof import('../src/validation/ydb-validate.provider.js'))['ClassValidatorProvider'];

beforeAll(async () => {
  ({ ClassValidatorProvider } =
    await import('../src/validation/ydb-validate.provider.js'));
});

beforeEach(() => {
  validateCalls.length = 0;
  validateResult = [];
});

describe('ClassValidatorProvider (#95)', () => {
  it('по умолчанию передаёт skipMissingProperties: false (безопасный дефолт)', async () => {
    const provider = new ClassValidatorProvider();
    await provider.validate({ name: 'x' });

    expect(validateCalls).toHaveLength(1);
    expect(validateCalls[0].options?.skipMissingProperties).toBe(false);
  });

  it('skipMissingProperties: true восстанавливает прежнее поведение', async () => {
    const provider = new ClassValidatorProvider({
      skipMissingProperties: true,
    });
    await provider.validate({});

    expect(validateCalls[0].options?.skipMissingProperties).toBe(true);
  });

  it('skipMissingProperties: false задаётся явно', async () => {
    const provider = new ClassValidatorProvider({
      skipMissingProperties: false,
    });
    await provider.validate({});

    expect(validateCalls[0].options?.skipMissingProperties).toBe(false);
  });

  it('groups пробрасываются в class-validator', async () => {
    const provider = new ClassValidatorProvider({ groups: ['create'] });
    await provider.validate({});

    expect(validateCalls[0].options?.groups).toEqual(['create']);
  });

  it('валидный объект — пустой список ошибок', async () => {
    validateResult = [];
    const provider = new ClassValidatorProvider();

    await expect(provider.validate({ name: 'x' })).resolves.toEqual([]);
  });

  it('ошибки маппятся в структуру: property/constraint/message/value', async () => {
    validateResult = [
      {
        property: 'name',
        constraints: { isNotEmpty: 'name should not be empty' },
        value: '',
      },
      {
        property: 'email',
        constraints: {
          isEmail: 'email must be an email',
          isNotEmpty: 'email should not be empty',
        },
        value: null,
      },
    ];
    const provider = new ClassValidatorProvider();

    const issues = await provider.validate({ name: '', email: null });

    const expected: YdbValidationErrorItem[] = [
      {
        property: 'name',
        constraint: 'isNotEmpty',
        message: 'name should not be empty',
        value: '',
      },
      {
        property: 'email',
        constraint: 'isEmail',
        message: 'email must be an email',
        value: null,
      },
      {
        property: 'email',
        constraint: 'isNotEmpty',
        message: 'email should not be empty',
        value: null,
      },
    ];
    expect(issues).toEqual(expected);
  });

  it('вложенные children разворачиваются с путём через точку', async () => {
    validateResult = [
      {
        property: 'profile',
        children: [
          {
            property: 'address',
            constraints: { isNotEmpty: 'address should not be empty' },
            value: undefined,
          },
        ],
      },
    ];
    const provider = new ClassValidatorProvider();

    const issues = await provider.validate({ profile: {} });

    // У родителя нет своих constraints — дубли не создаются
    expect(issues).toEqual([
      {
        property: 'profile.address',
        constraint: 'isNotEmpty',
        message: 'address should not be empty',
        value: undefined,
      },
    ]);
  });

  it('аномальная ошибка без constraints/children не теряется', async () => {
    validateResult = [{ property: 'mystery', value: 1 }];
    const provider = new ClassValidatorProvider();

    const issues = await provider.validate({ mystery: 1 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      property: 'mystery',
      constraint: 'unknown',
    });
  });
});
