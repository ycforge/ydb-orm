import 'reflect-metadata';
import {
  YdbBaseEntity,
  YdbEntity,
  YdbPrimaryColumn,
  YdbColumn,
  getOrCreateRepository,
} from '../src/index.js';
import { createMockExecutor } from './helpers/mock-executor.js';

@YdbEntity('own_property_users')
class User extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  id: string;

  @YdbColumn('Utf8')
  name: string;
}

describe('schema membership excludes Object.prototype properties', () => {
  afterEach(() => User.setExecutor(undefined));

  it.each(['constructor', 'toString', '__proto__'])(
    'rejects undeclared %s in projections, sorting and predicates',
    async (field) => {
      const mock = createMockExecutor();
      User.setExecutor(mock.executor);
      await expect(User.findAll({}, { select: [field] })).rejects.toThrow(
        /Unknown field in select/,
      );
      await expect(User.query().select([field]).toYql()).rejects.toThrow(
        /Unknown field in select/,
      );
      expect(() => User.query().orderBy(field as 'id')).toThrow(
        /Unknown field in ORDER BY/,
      );
      await expect(User.findAll({ [field]: null })).rejects.toThrow(
        /Unknown field in WHERE/,
      );
      await expect(User.deleteBy({ [field]: null })).rejects.toThrow(
        /Unknown field in WHERE/,
      );
      await expect(
        User.updateBy({ id: '1' }, { [field]: null }),
      ).rejects.toThrow(/Unknown field in patch/);
      expect(mock.queries).toHaveLength(0);
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'rejects an update containing only a primary key and undeclared %s before SQL execution',
    async (field) => {
      const mock = createMockExecutor();
      User.setExecutor(mock.executor);
      const user = new User();
      user.id = '1';
      Object.defineProperty(user, field, {
        value: 'undeclared',
        enumerable: true,
        configurable: true,
        writable: true,
      });

      await expect(User.save(user)).rejects.toThrow(/no fields to update/);
      expect(mock.queries).toHaveLength(0);
    },
  );

  it('does not hydrate legacy secrets or replace the entity prototype', () => {
    const row = JSON.parse(
      '{"id":"1","name":"Alice","constructor":"legacy-secret","toString":"legacy-secret","__proto__":{"admin":true}}',
    ) as Record<string, unknown>;
    const user = getOrCreateRepository(User).persistence.instantiate(row);
    expect(Object.getPrototypeOf(user)).toBe(User.prototype);
    expect(user.constructor).toBe(User);
    expect(Object.hasOwn(user, 'toString')).toBe(false);
    expect(Object.hasOwn(user, '__proto__')).toBe(false);
    expect(JSON.stringify(user)).not.toContain('legacy-secret');
    expect(user.name).toBe('Alice');
  });
});
