import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  BeforeInsert,
  AfterInsert,
  AfterFind,
  BeforeRemove,
} from '../src/index.js';
import {
  createMockExecutor,
  type MockExecutor,
} from './helpers/mock-executor.js';

const calls: string[] = [];
// Длина recorded queries на момент вызова хука — для проверки порядка.
const queryCountAtHook: number[] = [];
let currentMock: MockExecutor | undefined;

@YdbEntity('hook_test')
class HookEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  name?: string;

  @BeforeInsert
  onInsert() {
    calls.push(`beforeInsert:${this.name}`);
    queryCountAtHook.push(currentMock?.queries.length ?? -1);
    this.name = `${this.name}!`;
  }

  @AfterInsert
  onInserted() {
    calls.push(`afterInsert:${this.name}`);
    queryCountAtHook.push(currentMock?.queries.length ?? -1);
  }

  @AfterFind
  onFound() {
    calls.push(`afterFind:${this.name}`);
  }

  @BeforeRemove
  onRemove() {
    calls.push(`beforeRemove:${this.uuid}`);
  }
}

const UUID_A = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';
const UUID_B = '6bd91505-d4f6-4a81-ab65-9dbc68cf4ed6';

function row(name: string, uuid: string) {
  return { uuid, name };
}

describe('lifecycle hooks', () => {
  afterEach(() => {
    calls.length = 0;
    queryCountAtHook.length = 0;
    currentMock = undefined;
    HookEntity.setExecutor(undefined as any);
  });

  it('beforeRemove вызывается при delete()', async () => {
    const r = row('A', UUID_A);
    // Один мок обслуживает оба запроса: SELECT (загрузка инстанса) и DELETE
    const mock = createMockExecutor([[r]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const deleted = await HookEntity.delete(r.uuid);

    expect(deleted).not.toBeNull();
    // Внутренняя загрузка через find() тоже проходит afterFind,
    // затем срабатывает beforeRemove
    expect(calls).toEqual([`afterFind:A`, `beforeRemove:${r.uuid}`]);
    // Первый запрос — загрузка сущности для хука, второй — DELETE
    expect(mock.queries).toHaveLength(2);
    expect(mock.queries[0].sql).toContain('SELECT');
    expect(mock.queries[1].sql).toContain('DELETE FROM `hook_test`');
  });

  it('delete() возвращает null, если запись не найдена (хук не вызывается)', async () => {
    const mock = createMockExecutor([[]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const deleted = await HookEntity.delete(UUID_A);

    expect(deleted).toBeNull();
    expect(calls).toEqual([]);
    // Запись не найдена на SELECT — DELETE не выполняется
    expect(mock.queries).toHaveLength(1);
  });

  it('beforeInsert вызывается при save() новой сущности', async () => {
    const mock = createMockExecutor([[]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const entity = new HookEntity();
    entity.name = 'B';
    await HookEntity.save(entity);

    expect(calls).toEqual(['beforeInsert:B', 'afterInsert:B!']);
  });

  it('afterFind вызывается ровно один раз в find()', async () => {
    const mock = createMockExecutor([[row('A', UUID_A)]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const found = await HookEntity.find({ uuid: UUID_A });

    expect(found?.name).toBe('A');
    expect(calls).toEqual(['afterFind:A']);
  });

  it('afterFind вызывается для каждого элемента findAll()', async () => {
    const mock = createMockExecutor([[row('A', UUID_A), row('B', UUID_B)]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const found = await HookEntity.findAll();

    expect(found).toHaveLength(2);
    expect(calls).toEqual(['afterFind:A', 'afterFind:B']);
  });

  it('afterFind не вызывается при пустом результате findAll()', async () => {
    const mock = createMockExecutor([[]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const found = await HookEntity.findAll({ name: 'missing' });

    expect(found).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('afterFind не вызывается в find(), если запись не найдена', async () => {
    const mock = createMockExecutor([[]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const found = await HookEntity.find({ uuid: UUID_A });

    expect(found).toBeNull();
    expect(calls).toEqual([]);
  });

  it('afterFind вызывается в query().getMany()', async () => {
    const mock = createMockExecutor([[row('A', UUID_A), row('B', UUID_B)]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const found = await HookEntity.query().where({ name: 'A' }).getMany();

    expect(found).toHaveLength(2);
    expect(calls).toEqual(['afterFind:A', 'afterFind:B']);
  });

  it('insertMany(): beforeInsert до формирования запроса, мутации попадают в БД, afterInsert после записи', async () => {
    const mock = createMockExecutor([[]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const a = new HookEntity();
    a.name = 'A';
    const b = new HookEntity();
    b.name = 'B';

    await HookEntity.insertMany([a, b]);

    // Порядок хуков: все beforeInsert → все afterInsert
    expect(calls).toEqual([
      'beforeInsert:A',
      'beforeInsert:B',
      'afterInsert:A!',
      'afterInsert:B!',
    ]);

    // beforeInsert — до формирования SQL/параметров (0 запросов),
    // afterInsert — после успешной записи (>0)
    expect(queryCountAtHook.slice(0, 2)).toEqual([0, 0]);
    expect(queryCountAtHook[2] ?? 0).toBeGreaterThan(0);
    expect(queryCountAtHook[3] ?? 0).toBeGreaterThan(0);

    // Мутации из beforeInsert попали в параметры запроса
    // (mapToYdb оборачивает Utf8-значение в { type, value })
    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0].params['name_0']).toMatchObject({ value: 'A!' });
    expect(mock.queries[0].params['name_1']).toMatchObject({ value: 'B!' });
    // Мутируются исходные инстансы, которые и возвращаются
    expect(a.name).toBe('A!');
    expect(b.name).toBe('B!');
  });

  it('insertMany() с пустым массивом не вызывает хуки и не выполняет запросов', async () => {
    const mock = createMockExecutor([[]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    await HookEntity.insertMany([]);

    expect(calls).toEqual([]);
    expect(mock.queries).toHaveLength(0);
  });

  it('updateBy() — bulk-операция без per-entity хуков', async () => {
    const mock = createMockExecutor([[{ uuid: UUID_A }]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const updated = await HookEntity.updateBy({ uuid: UUID_A }, { name: 'C' });

    expect(updated).toBe(1);
    expect(calls).toEqual([]);
    expect(mock.queries[0].sql).toContain('UPDATE `hook_test`');
  });

  it('deleteBy() — bulk-операция без per-entity хуков', async () => {
    const mock = createMockExecutor([[{ uuid: UUID_A }]]);
    currentMock = mock;
    HookEntity.setExecutor(mock.executor);

    const deleted = await HookEntity.deleteBy({ name: 'A' });

    expect(deleted).toBe(1);
    expect(calls).toEqual([]);
    expect(mock.queries[0].sql).toContain('DELETE FROM `hook_test`');
  });
});
