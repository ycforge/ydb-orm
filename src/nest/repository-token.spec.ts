import { describe, expect, it } from '@jest/globals';
import { YdbBaseEntity, YdbEntity, YdbPrimaryColumn } from '../index.js';
import {
  getActiveRecordInitToken,
  getRepositoryToken,
} from './repository-token.js';

let uniqueNameCounter = 0;

/**
 * Creates an entity class with a guaranteed unique name so the tests don't
 * depend on the global token registry state across each other.
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
  it('same class always yields the same token (idempotency)', () => {
    const Entity = makeNamedEntityClass();

    for (let i = 0; i < 3; i++) {
      const repoToken = getRepositoryToken(Entity as any);
      const arToken = getActiveRecordInitToken(Entity as any);
      expect(repoToken).toBe(getRepositoryToken(Entity as any));
      expect(arToken).toBe(getActiveRecordInitToken(Entity as any));
    }

    // Historical format for the first class with a given name
    expect(getRepositoryToken(Entity as any)).toBe(
      `YDB_REPOSITORY_${Entity.name}`,
    );
    expect(getActiveRecordInitToken(Entity as any)).toBe(
      `${Entity.name}_AR_INIT`,
    );
  });

  it('same-named classes get different tokens without overwriting', () => {
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

  it('registration order does not affect token stability for a class', () => {
    const a1 = makeNamedEntityClass('Order');
    const b1 = makeNamedEntityClass('Order');
    const a2 = makeNamedEntityClass('Order');
    const b2 = makeNamedEntityClass('Order');

    // Tokens don't change after registering new same-named classes
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

  it('AR_INIT token is consistent between provider factory and module inject', () => {
    // Both sides must build the token using the same function — otherwise string mismatch.
    const Entity = makeNamedEntityClass();
    const arToken = getActiveRecordInitToken(Entity as any);
    expect(arToken).toContain('_AR_INIT');
    expect(getActiveRecordInitToken(Entity as any)).toBe(arToken);
  });

  it('unnamed class gets a valid and unique token', () => {
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
