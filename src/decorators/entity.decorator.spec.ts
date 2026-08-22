import 'reflect-metadata';
import { jest } from '@jest/globals';
import { YdbEntity } from './entity.decorator.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { getRegisteredYdbEntities } from '../metadata/entity-registry.js';

// Валидация имени таблицы в @YdbEntity (#91): невалидное имя должно падать
// при декорировании (загрузке модуля), а не на первом DescribeTable/DDL,
// где из него уже собрали путь до первой ошибки квотинга.

describe('@YdbEntity table name validation (#91)', () => {
  /** Декорирует класс именем name — декоратор отрабатывает немедленно. */
  function decorate(name: string): void {
    @YdbEntity(name)
    class DecoratorValidationEntity {}
    void DecoratorValidationEntity;
  }

  it.each(['users', '_private', 'Users2', 'a'])(
    'accepts valid table name "%s"',
    (name) => {
      const before = getRegisteredYdbEntities().length;
      expect(() => decorate(name)).not.toThrow();
      // Валидная сущность попадает в глобальный реестр
      expect(getRegisteredYdbEntities().length).toBe(before + 1);
    },
  );

  it.each([
    ['empty string', ''],
    ['dash', 'bad-name'],
    ['space', 'my table'],
    ['dot', 'schema.table'],
    ['slash', 'dir/table'],
    ['starting digit', '1users'],
    ['cyrillic', 'пользователи'],
    ['SQL injection attempt', '`users`; DROP TABLE users'],
  ])('rejects invalid table name (%s)', (_label, name) => {
    const before = getRegisteredYdbEntities().length;
    // Строки в toThrow сопоставляются с текстом ошибки как подстроки
    expect(() => decorate(name)).toThrow('@YdbEntity: invalid table name');
    expect(() => decorate(name)).toThrow(JSON.stringify(name));
    expect(() => decorate(name)).toThrow('/^[a-zA-Z_][a-zA-Z0-9_]*$/');
    // Невалидная сущность не должна попасть в глобальный реестр
    expect(getRegisteredYdbEntities().length).toBe(before);
  });

  it.each([
    ['null', null],
    ['number', 42],
    ['object', {}],
  ] as const)('rejects non-string name (%s)', (_label, name) => {
    expect(() => decorate(name as unknown as string)).toThrow(
      '@YdbEntity: invalid table name',
    );
  });

  it('does not write entity metadata for invalid table name', () => {
    let thrown: unknown;
    try {
      @YdbEntity('bad-name')
      class InvalidNameEntity {}
      void InvalidNameEntity;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Декоратор упал до defineMetadata — метаданных сущности нет.
    // Проверяем через свежий WeakMap-кеш метаданных на классе-обёртке.
    const holder: { target?: new (...args: any[]) => any } = {};
    try {
      @YdbEntity('also bad')
      class AnotherInvalidEntity {}
      holder.target = AnotherInvalidEntity;
    } catch {
      // ожидаемо
    }
    expect(holder.target).toBeUndefined();
  });

  it('metadata of valid entity contains its table name', () => {
    @YdbEntity('validated_users')
    class ValidatedUsersEntity {}

    expect(getYdbEntityMetadata(ValidatedUsersEntity)?.tableName).toBe(
      'validated_users',
    );
  });

  it('validation runs eagerly at decoration time (#91)', () => {
    const spy = jest.fn<(message: string) => void>();
    expect(() => {
      try {
        decorate('bad/name');
      } catch (error) {
        spy((error as Error).message);
        throw error;
      }
    }).toThrow('@YdbEntity: invalid table name');
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('must match /^[a-zA-Z_][a-zA-Z0-9_]*$/'),
    );
  });
});
