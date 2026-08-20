import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  BeforeInsert,
  BeforeRemove,
} from '../src/index.js';
import { createMockExecutor } from './helpers/mock-executor.js';

const calls: string[] = [];

@YdbEntity('hook_test')
class HookEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  name?: string;

  @BeforeInsert
  onInsert() {
    calls.push(`beforeInsert:${this.name}`);
  }

  @BeforeRemove
  onRemove() {
    calls.push(`beforeRemove:${this.uuid}`);
  }
}

describe('lifecycle hooks', () => {
  afterEach(() => {
    calls.length = 0;
    HookEntity.setExecutor(undefined as any);
  });

  it('beforeRemove вызывается при delete()', async () => {
    const row = { uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5', name: 'A' };
    // Один мок обслуживает оба запроса: SELECT (загрузка инстанса) и DELETE
    const mock = createMockExecutor([[row]]);
    HookEntity.setExecutor(mock.executor);

    const deleted = await HookEntity.delete(row.uuid);

    expect(deleted).not.toBeNull();
    expect(calls).toEqual([`beforeRemove:${row.uuid}`]);
    // Первый запрос — загрузка сущности для хука, второй — DELETE
    expect(mock.queries).toHaveLength(2);
    expect(mock.queries[0].sql).toContain('SELECT');
    expect(mock.queries[1].sql).toContain('DELETE FROM `hook_test`');
  });

  it('delete() возвращает null, если запись не найдена (хук не вызывается)', async () => {
    const mock = createMockExecutor([[]]);
    HookEntity.setExecutor(mock.executor);

    const deleted = await HookEntity.delete(
      '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
    );

    expect(deleted).toBeNull();
    expect(calls).toEqual([]);
    // Запись не найдена на SELECT — DELETE не выполняется
    expect(mock.queries).toHaveLength(1);
  });

  it('beforeInsert вызывается при save() новой сущности', async () => {
    const mock = createMockExecutor([[]]);
    HookEntity.setExecutor(mock.executor);

    const entity = new HookEntity();
    entity.name = 'B';
    await HookEntity.save(entity);

    expect(calls).toEqual(['beforeInsert:B']);
  });
});
