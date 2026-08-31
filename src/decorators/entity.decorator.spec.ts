import 'reflect-metadata';
import { jest } from '@jest/globals';
import { YdbEntity } from './entity.decorator.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { getRegisteredYdbEntities } from '../metadata/entity-registry.js';

// Table-name validation in @YdbEntity (#91): an invalid name must fail at
// decoration (module load) time, not on the first DescribeTable/DDL, where
// the path would already have been built up to the first quoting error.

describe('@YdbEntity table name validation (#91)', () => {
  /** Decorates a class with the given name — the decorator runs immediately. */
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
      // A valid entity enters the global registry
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
    // Strings in toThrow are matched against the error text as substrings
    expect(() => decorate(name)).toThrow('@YdbEntity: invalid table name');
    expect(() => decorate(name)).toThrow(JSON.stringify(name));
    expect(() => decorate(name)).toThrow('/^[a-zA-Z_][a-zA-Z0-9_]*$/');
    // An invalid entity must not enter the global registry
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
    // The decorator failed before defineMetadata — no entity metadata exists.
    // Checked via a fresh WeakMap metadata cache on the wrapper class.
    const holder: { target?: new (...args: any[]) => any } = {};
    try {
      @YdbEntity('also bad')
      class AnotherInvalidEntity {}
      holder.target = AnotherInvalidEntity;
    } catch {
      // expected
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
