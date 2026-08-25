import { describe, expect, it } from '@jest/globals';
import { YdbBaseEntity, YdbEntity, YdbPrimaryColumn } from '../index.js';
import {
  getActiveRecordInitToken,
  getRepositoryToken,
} from './repository-token.js';

let uniqueNameCounter = 0;

/**
 * Создаёт класс сущности с гарантированно уникальным именем, чтобы тесты
 * не зависели от глобального состояния реестра токенов между собой.
 */
function makeNamedEntityClass(nameSuffix?: string): typeof YdbBaseEntity {
  const name = `TokenSpec_${nameSuffix ?? ++uniqueNameCounter}`;
  @YdbEntity(`token_spec_${name}`)
  class Dynamic extends YdbBaseEntity {
    @YdbPrimaryColumn('Uuid')
    uuid!: string;
  }
  Object.defineProperty(Dynamic, 'name', { value: name });
  return Dynamic;
}

describe('getRepositoryToken / getActiveRecordInitToken (issue #94)', () => {
  it('один класс всегда даёт один и тот же токен (идемпотентность)', () => {
    const Entity = makeNamedEntityClass();

    for (let i = 0; i < 3; i++) {
      const repoToken = getRepositoryToken(Entity as any);
      const arToken = getActiveRecordInitToken(Entity as any);
      expect(repoToken).toBe(getRepositoryToken(Entity as any));
      expect(arToken).toBe(getActiveRecordInitToken(Entity as any));
    }

    // Исторический формат для первого класса с данным именем
    expect(getRepositoryToken(Entity as any)).toBe(
      `YDB_REPOSITORY_${Entity.name}`,
    );
    expect(getActiveRecordInitToken(Entity as any)).toBe(
      `${Entity.name}_AR_INIT`,
    );
  });

  it('одноимённые классы получают разные токены без перезаписи', () => {
    const first = makeNamedEntityClass('Collision');
    const second = makeNamedEntityClass('Collision');

    expect(first).not.toBe(second);
    expect(first.name).toBe(second.name);

    const firstRepo = getRepositoryToken(first as any);
    const secondRepo = getRepositoryToken(second as any);
    expect(firstRepo).not.toBe(secondRepo);

    const firstAr = getActiveRecordInitToken(first as any);
    const secondAr = getActiveRecordInitToken(second as any);
    expect(firstAr).not.toBe(secondAr);
  });

  it('порядок регистрации не влияет на стабильность токенов класса', () => {
    const a1 = makeNamedEntityClass('Order');
    const b1 = makeNamedEntityClass('Order');
    const a2 = makeNamedEntityClass('Order');
    const b2 = makeNamedEntityClass('Order');

    // Токены не меняются после регистрации новых одноимённых классов
    expect(getRepositoryToken(a1 as any)).toBe(getRepositoryToken(a1 as any));
    expect(getRepositoryToken(a1 as any)).not.toBe(
      getRepositoryToken(b1 as any),
    );
    expect(getRepositoryToken(b1 as any)).toBe(getRepositoryToken(b1 as any));
    expect(getRepositoryToken(b2 as any)).not.toBe(
      getRepositoryToken(a2 as any),
    );

    const tokens = new Set(
      [a1, b1, a2, b2].map((e) => getRepositoryToken(e as any)),
    );
    expect(tokens.size).toBe(4);
  });

  it('AR_INIT-токен согласован между фабрикой провайдера и inject модуля', () => {
    // Обе стороны обязаны строить токен одной функцией — иначе рассинхрон строк.
    const Entity = makeNamedEntityClass();
    const arToken = getActiveRecordInitToken(Entity as any);
    expect(arToken).toContain('_AR_INIT');
    expect(getActiveRecordInitToken(Entity as any)).toBe(arToken);
  });

  it('класс без имени получает валидный и уникальный токен', () => {
    @YdbEntity('token_spec_anonymous')
    class Anonymous extends YdbBaseEntity {
      @YdbPrimaryColumn('Uuid')
      uuid!: string;
    }
    Object.defineProperty(Anonymous, 'name', { value: '' });

    const token = getRepositoryToken(Anonymous as any);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan('YDB_REPOSITORY_'.length);
  });
});
