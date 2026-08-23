import { describe, it, expect } from '@jest/globals';
import { YdbEntityPersistence } from './entity-persistence.js';
import { YdbEntityRelations } from '../relations/entity-relations.js';

/**
 * Проводка QueryOptions.idempotent (#27): точки исполнения ORM обязаны
 * передавать явную пометку идемпотентности в нижележащий запрос — только
 * она разрешает retry-политике повторять запрос (fail-safe по умолчанию:
 * без пометки запрос выполняется ровно один раз).
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

describe('QueryOptions.idempotent пробрасывается в запрос (#27)', () => {
  it('persistence.executeQuery: пометка применяется при { idempotent: true }', async () => {
    const persistence: any = Object.create(YdbEntityPersistence.prototype);

    const marked: boolean[] = [];
    await persistence.executeQuery(fakeQuery(marked), { idempotent: true });
    expect(marked).toEqual([true]);

    const unmarked: boolean[] = [];
    await persistence.executeQuery(fakeQuery(unmarked), {});
    expect(unmarked).toEqual([]);
  });

  it('relations.executeQuery: пометка применяется при { idempotent: true }', async () => {
    const relations: any = Object.create(YdbEntityRelations.prototype);

    const marked: boolean[] = [];
    await relations.executeQuery(fakeQuery(marked), { idempotent: true });
    expect(marked).toEqual([true]);

    const unmarked: boolean[] = [];
    await relations.executeQuery(fakeQuery(unmarked), undefined);
    expect(unmarked).toEqual([]);
  });
});
