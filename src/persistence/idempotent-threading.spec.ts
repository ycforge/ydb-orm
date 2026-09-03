import { describe, it, expect } from '@jest/globals';
import { YdbEntityPersistence } from './entity-persistence.js';
import { YdbEntityRelations } from '../relations/entity-relations.js';

/**
 * Threading of QueryOptions.idempotent (#27): ORM execution points must
 * forward an explicit idempotency flag to the underlying query — only it
 * allows the retry policy to repeat a request (fail-safe by default: without
 * the flag the query runs exactly once).
 */

function fakeQuery(marks: boolean[]): any {
  const query: any = {
    signal() {
      return query;
    },
    timeout() {
      return query;
    },
    idempotent(flag?: boolean) {
      marks.push(flag !== false);
      return query;
    },
    then(onFulfilled?: (value: unknown) => unknown) {
      return Promise.resolve([[{ ok: 1 }]]).then(onFulfilled);
    },
  };
  return query;
}

describe('QueryOptions.idempotent is threaded into the query (#27)', () => {
  it('persistence.executeQuery: marker applied when { idempotent: true }', async () => {
    const persistence: any = Object.create(YdbEntityPersistence.prototype);

    const marked: boolean[] = [];
    await persistence.executeQuery(fakeQuery(marked), { idempotent: true });
    expect(marked).toEqual([true]);

    const unmarked: boolean[] = [];
    await persistence.executeQuery(fakeQuery(unmarked), {});
    expect(unmarked).toEqual([]);
  });

  it('relations.executeQuery: marker applied when { idempotent: true }', async () => {
    const relations: any = Object.create(YdbEntityRelations.prototype);

    const marked: boolean[] = [];
    await relations.executeQuery(fakeQuery(marked), { idempotent: true });
    expect(marked).toEqual([true]);

    const unmarked: boolean[] = [];
    await relations.executeQuery(fakeQuery(unmarked), undefined);
    expect(unmarked).toEqual([]);
  });
});
