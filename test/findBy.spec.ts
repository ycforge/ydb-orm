import 'reflect-metadata';
import { Uuid } from '@ydbjs/value/primitive';
import { createMockExecutor } from './helpers/mock-executor.js';
import { UserEntity } from './fixtures/user/user.entity.js';

describe('findBy / findOneBy', () => {
  afterEach(() => {
    UserEntity.setExecutor(undefined as any);
    UserEntity.setEncryptionProvider(undefined as any);
    UserEntity.setBlindIndexProvider(undefined as any);
  });

  const uuid1 = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';
  const uuid2 = '00000000-0000-0000-0000-000000000002';

  it('findBy() возвращает несколько сущностей', async () => {
    const mock = createMockExecutor([
      [
        { uuid: uuid1, full_name: 'Alice' },
        { uuid: uuid2, full_name: 'Bob' },
      ],
    ]);
    UserEntity.setExecutor(mock.executor);

    const result = await UserEntity.findBy({ uuid: uuid1 });

    expect(result).toHaveLength(2);
    expect(result[0].uuid).toBe(uuid1);
    expect(result[1].uuid).toBe(uuid2);
    expect(mock.queries[0].sql).toContain('WHERE');
  });

  it('findBy() возвращает пустой массив при отсутствии строк', async () => {
    const mock = createMockExecutor([[]]);
    UserEntity.setExecutor(mock.executor);

    const result = await UserEntity.findBy({ uuid: uuid1 });

    expect(result).toEqual([]);
  });

  it('findBy() применяет WHERE-условия', async () => {
    const mock = createMockExecutor([[{ uuid: uuid1, full_name: 'Charlie' }]]);
    UserEntity.setExecutor(mock.executor);

    await UserEntity.findBy({ uuid: uuid1 });

    expect(mock.queries[0].sql).toContain('`uuid` = $uuid');
    expect(mock.queries[0].params.uuid).toBeInstanceOf(Uuid);
  });

  it('findOneBy() возвращает сущность при нахождении', async () => {
    const mock = createMockExecutor([[{ uuid: uuid1, full_name: 'Diana' }]]);
    UserEntity.setExecutor(mock.executor);

    const result = await UserEntity.findOneBy({ uuid: uuid1 });

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(uuid1);
    expect(result!.full_name).toBe('Diana');
  });

  it('findOneBy() возвращает null при отсутствии строк', async () => {
    const mock = createMockExecutor([[]]);
    UserEntity.setExecutor(mock.executor);

    const result = await UserEntity.findOneBy({ uuid: uuid1 });

    expect(result).toBeNull();
  });

  it('findOneBy() требует хотя бы одно условие', async () => {
    const mock = createMockExecutor([[]]);
    UserEntity.setExecutor(mock.executor);

    await expect(UserEntity.findOneBy({})).rejects.toThrow(
      'requires at least one condition',
    );
  });
});
