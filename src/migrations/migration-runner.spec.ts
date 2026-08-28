import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import type { YdbExecutor } from '../../src/index.js';
import { YdbMigration, executeSql } from './migration.interface.js';
import {
  AppliedMigration,
  YdbMigrationRunner,
  deriveMigrationRowId,
  migrationIdentity,
} from './migration-runner.js';

const sha256 = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

interface StoreRow {
  id: string;
  timestamp: bigint;
  name: string;
  hash: string | null;
  state: string | null;
}

interface RecordedQuery {
  sql: string;
  params: Record<string, any>;
}

interface StatefulExecutor {
  executor: YdbExecutor;
  queries: RecordedQuery[];
  rows: Map<string, StoreRow>;
}

const paramValue = (param: unknown): unknown =>
  (param as { value?: unknown } | undefined)?.value;

const paramBigInt = (param: unknown): bigint =>
  BigInt(Number(paramValue(param) ?? 0));

const paramString = (param: unknown, fallback = ''): string => {
  const value = paramValue(param);
  return typeof value === 'string' ? value : fallback;
};

/** Ключ строки (id): Int64 приходит как bigint. */
const paramKey = (param: unknown): string => {
  const value = paramValue(param);
  if (typeof value === 'bigint' || typeof value === 'number') {
    return String(value);
  }
  return typeof value === 'string' ? value : '';
};

/**
 * Stateful мок executor с PK-уникальностью: имитирует таблицу учёта
 * миграций и атомарность PRIMARY KEY на INSERT (для теста гонок).
 */
function createStatefulExecutor(
  options: {
    /** Начальные строки таблицы учёта. */
    rows?: (Partial<AppliedMigration> & { timestamp: number })[];
    /** SELECT-проба legacy-колонок падает (таблица старого формата). */
    failProbe?: boolean;
    /** Внедрить сбой на конкретный SQL. */
    failOn?: (sql: string) => Error | undefined;
    /** Общее хранилище для нескольких раннеров (тест гонок). */
    store?: Map<string, StoreRow>;
  } = {},
): StatefulExecutor {
  const rows = options.store ?? new Map<string, StoreRow>();
  const queries: RecordedQuery[] = [];

  (options.rows ?? []).forEach((row, index) => {
    const id = String(row.id ?? index + 1);
    rows.set(id, {
      id,
      timestamp: BigInt(row.timestamp),
      name: String(row.name),
      hash: row.hash ?? null,
      state: row.state ?? 'applied',
    });
  });

  const applySql = (sql: string, params: Record<string, any>): any[][] => {
    const injected = options.failOn?.(sql);
    if (injected) throw injected;

    if (sql.startsWith('CREATE TABLE')) return [];
    if (sql.startsWith('SELECT `hash`')) {
      if (options.failProbe) throw new Error('column `hash` was not found');
      return [];
    }
    if (sql.startsWith('SELECT')) return [[...rows.values()]];
    if (sql.startsWith('INSERT INTO')) {
      const id = paramKey(params.id);
      if (rows.has(id)) {
        throw new Error(`Duplicate key lookup: id=${id} already exists`);
      }
      rows.set(id, {
        id,
        timestamp: paramBigInt(params.timestamp),
        name: paramString(params.name),
        hash: (paramValue(params.hash) as string | undefined) || null,
        state: paramString(params.state, 'applied'),
      });
      return [];
    }
    if (sql.startsWith('UPDATE')) {
      const row = rows.get(paramKey(params.id));
      if (row) {
        row.state = paramString(params.state);
        row.timestamp = paramBigInt(params.timestamp);
      }
      return [];
    }
    if (sql.startsWith('DELETE')) {
      rows.delete(paramKey(params.id));
      return [];
    }
    return [];
  };

  const executor: any = jest.fn((strings: TemplateStringsArray) => {
    const recorded: RecordedQuery = { sql: strings[0], params: {} };
    const query: any = {
      parameter(name: string, value: unknown) {
        recorded.params[name] = value;
        return query;
      },
      timeout() {
        return query;
      },
      signal() {
        return query;
      },
      cancel() {
        return query;
      },
      then(
        onFulfilled?: ((value: any[][]) => any) | null,
        onRejected?: ((reason: unknown) => any) | null,
      ) {
        return Promise.resolve()
          .then(() => {
            const result = applySql(recorded.sql, recorded.params);
            queries.push(recorded);
            return result;
          })
          .then(onFulfilled ?? undefined, onRejected ?? undefined);
      },
    };
    return query;
  });

  return { executor: executor, queries, rows };
}

const migrationFactory = (
  name: string,
  opts: { hash?: string; upError?: Error; downError?: Error } = {},
) => {
  const up = jest.fn(async (executor: YdbExecutor) => {
    await executeSql(executor, `UP ${name}`);
    if (opts.upError) throw opts.upError;
  });
  const down = jest.fn(async (executor: YdbExecutor) => {
    await executeSql(executor, `DOWN ${name}`);
    if (opts.downError) throw opts.downError;
  });
  const migration: YdbMigration = { name, hash: opts.hash, up, down };
  return { migration, up, down };
};

const insertQueries = (mock: StatefulExecutor) =>
  mock.queries.filter((q) => q.sql.startsWith('INSERT INTO'));

describe('YdbMigrationRunner (#101)', () => {
  describe('bookkeeping table', () => {
    it('creates the migrations table with hash and state columns', async () => {
      const mock = createStatefulExecutor();
      const runner = new YdbMigrationRunner(mock.executor);

      await runner.getAppliedMigrations();

      expect(mock.queries[0].sql).toContain(
        'CREATE TABLE IF NOT EXISTS `ydb_migrations`',
      );
      expect(mock.queries[0].sql).toContain('`hash` Utf8');
      expect(mock.queries[0].sql).toContain('`state` Utf8');
      expect(mock.queries[0].sql).toContain('PRIMARY KEY (`id`)');
    });

    it('upgrades a legacy table by adding missing columns once', async () => {
      const mock = createStatefulExecutor({ failProbe: true });
      const runner = new YdbMigrationRunner(mock.executor);

      await runner.getAppliedMigrations();
      // Повторный вызов не должен повторять апгрейд
      await runner.getAppliedMigrations();

      const alters = mock.queries.filter((q) =>
        q.sql.startsWith('ALTER TABLE'),
      );
      expect(alters).toHaveLength(2);
      expect(alters[0].sql).toContain('ADD COLUMN `hash` Utf8');
      expect(alters[1].sql).toContain('ADD COLUMN `state` Utf8');
    });

    /** Колонки таблицы учёта для DescribeTable-шва (#176). */
    const bookkeepingColumns = (hasHash: boolean, hasState: boolean) =>
      new Map<string, unknown>([
        ['id', 3],
        ['timestamp', 3],
        ['name', 4],
        ...(hasHash ? ([['hash', 4]] as const) : []),
        ...(hasState ? ([['state', 4]] as const) : []),
      ]);

    it('#176 adds both missing columns by DescribeTable metadata', async () => {
      const mock = createStatefulExecutor();
      const describeTable = jest.fn((_t: string): Promise<any> =>
        Promise.resolve({
          columns: bookkeepingColumns(false, false),
          primaryKey: ['id'],
          indexes: [],
        }),
      );
      const runner = new YdbMigrationRunner(
        mock.executor,
        undefined,
        describeTable,
      );

      await runner.getAppliedMigrations();

      const alters = mock.queries.filter((q) =>
        q.sql.startsWith('ALTER TABLE'),
      );
      expect(alters).toHaveLength(2);
      expect(alters[0].sql).toContain('ADD COLUMN `hash` Utf8');
      expect(alters[1].sql).toContain('ADD COLUMN `state` Utf8');
    });

    it('#176 adding columns is resumable after a failure between ALTERs', async () => {
      const store = new Map<string, StoreRow>();
      const failOnState = (sql: string) =>
        sql.includes('ADD COLUMN `state`')
          ? new Error('boom on state')
          : undefined;
      const mock1 = createStatefulExecutor({ store, failOn: failOnState });

      let hasHash = false;
      const hasState = false;
      const describeTable = jest.fn((_t: string): Promise<any> =>
        Promise.resolve({
          columns: bookkeepingColumns(hasHash, hasState),
          primaryKey: ['id'],
          indexes: [],
        }),
      );

      const first = new YdbMigrationRunner(
        mock1.executor,
        undefined,
        describeTable,
      );
      await expect(first.getAppliedMigrations()).rejects.toThrow(
        'boom on state',
      );
      expect(
        mock1.queries.filter((q) => q.sql.startsWith('ALTER TABLE')),
      ).toHaveLength(1);

      // Первый ALTER (`hash`) прошёл; повторный запуск добавляет только `state`.
      hasHash = true;
      const mock2 = createStatefulExecutor({ store });
      const second = new YdbMigrationRunner(
        mock2.executor,
        undefined,
        describeTable,
      );
      await second.getAppliedMigrations();

      const alters = [
        ...mock1.queries.filter((q) => q.sql.startsWith('ALTER TABLE')),
        ...mock2.queries.filter((q) => q.sql.startsWith('ALTER TABLE')),
      ];
      expect(alters).toHaveLength(2);
      expect(alters[0].sql).toContain('ADD COLUMN `hash` Utf8');
      expect(alters[1].sql).toContain('ADD COLUMN `state` Utf8');
    });

    it('#176 adds only the missing `hash` column', async () => {
      const mock = createStatefulExecutor();
      const describeTable = jest.fn((_t: string): Promise<any> =>
        Promise.resolve({
          columns: bookkeepingColumns(false, true),
          primaryKey: ['id'],
          indexes: [],
        }),
      );
      const runner = new YdbMigrationRunner(
        mock.executor,
        undefined,
        describeTable,
      );

      await runner.getAppliedMigrations();

      const alters = mock.queries.filter((q) =>
        q.sql.startsWith('ALTER TABLE'),
      );
      expect(alters).toHaveLength(1);
      expect(alters[0].sql).toContain('ADD COLUMN `hash` Utf8');
    });

    it('#176 adds only the missing `state` column', async () => {
      const mock = createStatefulExecutor();
      const describeTable = jest.fn((_t: string): Promise<any> =>
        Promise.resolve({
          columns: bookkeepingColumns(true, false),
          primaryKey: ['id'],
          indexes: [],
        }),
      );
      const runner = new YdbMigrationRunner(
        mock.executor,
        undefined,
        describeTable,
      );

      await runner.getAppliedMigrations();

      const alters = mock.queries.filter((q) =>
        q.sql.startsWith('ALTER TABLE'),
      );
      expect(alters).toHaveLength(1);
      expect(alters[0].sql).toContain('ADD COLUMN `state` Utf8');
    });

    it('#176 fully upgraded table performs no ALTER statements', async () => {
      const mock = createStatefulExecutor();
      const describeTable = jest.fn((_t: string): Promise<any> =>
        Promise.resolve({
          columns: bookkeepingColumns(true, true),
          primaryKey: ['id'],
          indexes: [],
        }),
      );
      const runner = new YdbMigrationRunner(
        mock.executor,
        undefined,
        describeTable,
      );

      await runner.getAppliedMigrations();

      expect(
        mock.queries.filter((q) => q.sql.startsWith('ALTER TABLE')),
      ).toHaveLength(0);
    });

    it('#176 transient DescribeTable error propagates without any ALTER', async () => {
      const mock = createStatefulExecutor();
      const describeTable = jest.fn((_t: string): Promise<any> =>
        Promise.reject(new Error('table is unavailable')),
      );
      const runner = new YdbMigrationRunner(
        mock.executor,
        undefined,
        describeTable,
      );

      await expect(runner.getAppliedMigrations()).rejects.toThrow(
        'table is unavailable',
      );
      expect(
        mock.queries.filter((q) => q.sql.startsWith('ALTER TABLE')),
      ).toHaveLength(0);
    });

    it('#176 permission DescribeTable error propagates without any ALTER', async () => {
      const mock = createStatefulExecutor();
      const describeTable = jest.fn((_t: string): Promise<any> =>
        Promise.reject(new Error('SCHEME_ERROR: access denied')),
      );
      const runner = new YdbMigrationRunner(
        mock.executor,
        undefined,
        describeTable,
      );

      await expect(runner.getAppliedMigrations()).rejects.toThrow(
        'access denied',
      );
      expect(
        mock.queries.filter((q) => q.sql.startsWith('ALTER TABLE')),
      ).toHaveLength(0);
    });

    it('ensures the table only once per runner instance (#101)', async () => {
      // Раньше ensureMigrationsTable выполнялся перед каждым чтением
      const mock = createStatefulExecutor({
        rows: [{ timestamp: 1000, name: '1-First' }],
      });
      const runner = new YdbMigrationRunner(mock.executor);

      await runner.getAppliedMigrations();
      await runner.status([migrationFactory('1-First').migration]);
      await runner.status([]);

      expect(
        mock.queries.filter((q) => q.sql.startsWith('CREATE TABLE')),
      ).toHaveLength(1);
    });
  });

  describe('stable identity', () => {
    it('skips an applied migration even after its file was renamed', async () => {
      // Раньше сопоставление шло только по имени: переименование файла
      // приводило к повторному применению up()
      const hash = sha256('create users');
      const mock = createStatefulExecutor({
        rows: [{ timestamp: 1000, name: '100-OldName', hash }],
      });
      const runner = new YdbMigrationRunner(mock.executor);
      const renamed = migrationFactory('200-NewName', { hash });

      const executed = await runner.run([renamed.migration]);

      expect(executed).toEqual([]);
      expect(renamed.up).not.toHaveBeenCalled();
    });

    it('matches legacy records without hash by name (backwards compat)', async () => {
      const mock = createStatefulExecutor({
        rows: [{ timestamp: 1000, name: '1-First' }], // запись старого формата
      });
      const runner = new YdbMigrationRunner(mock.executor);
      const m1 = migrationFactory('1-First', { hash: sha256('first') });
      const m2 = migrationFactory('2-Second', { hash: sha256('second') });

      const executed = await runner.run([m1.migration, m2.migration]);

      expect(executed).toEqual(['2-Second']);
      expect(m1.up).not.toHaveBeenCalled();
      expect(m2.up).toHaveBeenCalled();
    });

    it('fails when an applied migration was modified afterwards', async () => {
      const mock = createStatefulExecutor({
        rows: [
          { timestamp: 1000, name: '1-Mutated', hash: sha256('original') },
        ],
      });
      const runner = new YdbMigrationRunner(mock.executor);
      const edited = migrationFactory('1-Mutated', { hash: sha256('edited') });

      await expect(runner.run([edited.migration])).rejects.toThrow(
        /was modified after it was applied/,
      );
      expect(edited.up).not.toHaveBeenCalled();
    });

    it('derives a deterministic row id from the identity', () => {
      const idOf = (hash: string) =>
        deriveMigrationRowId(migrationIdentity({ hash } as YdbMigration));

      // Одинаковая идентичность → одинаковый id у любых процессов:
      // на этом строится атомарный claim через PRIMARY KEY
      expect(idOf('h1')).toBe(idOf('h1'));
      expect(idOf('h1')).not.toBe(idOf('h2'));
      expect(Number.isSafeInteger(idOf('h1'))).toBe(true);
      expect(idOf('h1')).toBeGreaterThan(0);
      expect(idOf('h1')).toBeLessThan(2 ** 52);
    });

    it('falls back to name when no hash is set', () => {
      expect(migrationIdentity({ name: '1-X' } as YdbMigration)).toBe('1-X');
    });
  });

  describe('duplicate input migrations', () => {
    it('fails clearly on duplicate names in run()', async () => {
      const mock = createStatefulExecutor();
      const runner = new YdbMigrationRunner(mock.executor);

      await expect(
        runner.run([
          migrationFactory('1-Dup').migration,
          migrationFactory('1-Dup').migration,
        ]),
      ).rejects.toThrow(/Duplicate migration name in runner input: "1-Dup"/);
    });

    it('fails on identical content under different names in run()', async () => {
      const hash = sha256('same body');
      const mock = createStatefulExecutor();
      const runner = new YdbMigrationRunner(mock.executor);

      await expect(
        runner.run([
          migrationFactory('1-A', { hash }).migration,
          migrationFactory('2-B', { hash }).migration,
        ]),
      ).rejects.toThrow(/Duplicate migration identity in runner input/);
    });

    it('fails on duplicates in status() and revert()', async () => {
      const runner = new YdbMigrationRunner(createStatefulExecutor().executor);

      await expect(
        runner.status([
          migrationFactory('1-Dup').migration,
          migrationFactory('1-Dup').migration,
        ]),
      ).rejects.toThrow(/Duplicate migration name/);

      await expect(
        runner.revert([
          migrationFactory('1-A').migration,
          migrationFactory('1-A').migration,
        ]),
      ).rejects.toThrow(/Duplicate migration name/);
    });
  });

  describe('partial application safety', () => {
    it('claims the migration before running up()', async () => {
      const mock = createStatefulExecutor();
      const runner = new YdbMigrationRunner(mock.executor);

      await runner.run([migrationFactory('1-First').migration]);

      const inserts = insertQueries(mock);
      expect(inserts).toHaveLength(1);
      const upIdx = mock.queries.findIndex((q) => q.sql === 'UP 1-First');
      const claimIdx = mock.queries.indexOf(inserts[0]);
      expect(upIdx).toBeGreaterThan(claimIdx);

      // claim пишет маркер started и стабильную идентичность до up()
      expect(String(inserts[0].params.state.value)).toBe('started');
      expect(String(inserts[0].params.name.value)).toBe('1-First');
      const updateAfterUp = mock.queries.find((q) =>
        q.sql.startsWith('UPDATE'),
      );
      expect(updateAfterUp).toBeDefined();
      expect(mock.queries.indexOf(updateAfterUp!)).toBeGreaterThan(upIdx);
    });

    it('never re-runs a migration blindly after a mid-way failure', async () => {
      const first = createStatefulExecutor();
      const failing = migrationFactory('1-Broken', {
        upError: new Error('DDL exploded halfway'),
      });

      await expect(
        new YdbMigrationRunner(first.executor).run([failing.migration]),
      ).rejects.toThrow(/failed mid-way and was left in "started" state/);
      expect(failing.up).toHaveBeenCalledTimes(1);

      // Маркер частичного применения остался в таблице
      const [marker] = [...first.rows.values()];
      expect(marker.state).toBe('started');

      // Повторный запуск отказывается выполнять миграцию заново вслепую
      const retry = migrationFactory('1-Broken');
      const second = createStatefulExecutor({ store: first.rows });
      await expect(
        new YdbMigrationRunner(second.executor).run([retry.migration]),
      ).rejects.toThrow(
        /Previous migration run did not finish[\s\S]*"1-Broken" left in "started" state/,
      );
      expect(retry.up).not.toHaveBeenCalled();
    });

    it('recovers via markMigrationApplied after manual completion', async () => {
      const mock = createStatefulExecutor();
      const runner = new YdbMigrationRunner(mock.executor);
      const boom = new Error('boom');
      const broken = migrationFactory('1-Broken', { upError: boom });
      const failure = await runner.run([broken.migration]).then(
        () => null,
        (error: Error) => error,
      );
      // Исходная ошибка не потеряна: доступна как cause обёртки
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).toMatch(/failed mid-way/);
      expect((failure as any).cause).toBe(boom);

      await runner.markMigrationApplied('1-Broken');
      expect([...mock.rows.values()][0].state).toBe('applied');

      // Следующий run больше не пытается её выполнить
      const again = migrationFactory('1-Broken');
      const executed = await new YdbMigrationRunner(mock.executor).run([
        again.migration,
      ]);
      expect(executed).toEqual([]);
      expect(again.up).not.toHaveBeenCalled();
    });

    it('recovers via removeMigrationRecord after manual rollback', async () => {
      const mock = createStatefulExecutor();
      const runner = new YdbMigrationRunner(mock.executor);
      const broken = migrationFactory('1-Broken', {
        upError: new Error('boom'),
      });
      await expect(runner.run([broken.migration])).rejects.toThrow(
        /failed mid-way/,
      );

      await runner.removeMigrationRecord('1-Broken');
      expect(mock.rows.size).toBe(0);

      // Пользователь явно решил откатить схему — миграция применится заново
      const fixed = migrationFactory('1-Broken');
      const executed = await new YdbMigrationRunner(mock.executor).run([
        fixed.migration,
      ]);
      expect(executed).toEqual(['1-Broken']);
      expect(fixed.up).toHaveBeenCalledTimes(1);
    });

    it('resolves recovery target by hash or by migration object', async () => {
      const hash = sha256('target');
      const mock = createStatefulExecutor();
      const runner = new YdbMigrationRunner(mock.executor);
      const broken = migrationFactory('1-Broken', {
        hash,
        upError: new Error('boom'),
      });
      await expect(runner.run([broken.migration])).rejects.toThrow(
        /failed mid-way/,
      );

      await runner.markMigrationApplied(broken.migration);
      expect([...mock.rows.values()][0].state).toBe('applied');

      await runner.removeMigrationRecord(hash);
      expect(mock.rows.size).toBe(0);
    });

    it('throws when recovering an unknown migration', async () => {
      const runner = new YdbMigrationRunner(createStatefulExecutor().executor);

      await expect(runner.markMigrationApplied('404-Ghost')).rejects.toThrow(
        /No migration record found/,
      );
    });
  });

  describe('concurrent runners', () => {
    it('applies a contested migration exactly once (DB-level atomicity)', async () => {
      // Общее хранилище = одна БД; два независимых процесса-раннера.
      // id строки детерминирован идентичностью миграции, поэтому оба
      // процесса претендуют на одну строку и сталкиваются на PK.
      const store = new Map<string, StoreRow>();
      const mkExecutor = () => createStatefulExecutor({ store }).executor;
      const runnerA = new YdbMigrationRunner(mkExecutor());
      const runnerB = new YdbMigrationRunner(mkExecutor());

      const makeSlowMigration = (label: string) =>
        ({
          name: '1-Contested',
          hash: sha256('contested'),
          up: jest.fn(async (executor: YdbExecutor) => {
            await executeSql(executor, `UP ${label}`);
            await new Promise((r) => setTimeout(r, 20));
          }),
          down: jest.fn(async () => {}),
        }) as unknown as YdbMigration & { up: any; down: any };
      const mA = makeSlowMigration('A');
      const mB = makeSlowMigration('B');

      const results = await Promise.allSettled([
        runnerA.run([mA]),
        runnerB.run([mB]),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled',
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      // Победитель применил миграцию, проигравший упал на своём claim
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0].value).toEqual(['1-Contested']);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.message).toMatch(
        /another migration process is likely running concurrently/,
      );

      // up() выполнился ровно один раз — двойного применения нет
      expect(mA.up.mock.calls.length + mB.up.mock.calls.length).toBe(1);

      const records = [...store.values()];
      expect(records).toHaveLength(1);
      expect(records[0].state).toBe('applied');
    });
  });

  describe('revert consistency', () => {
    it('refuses to revert a record left "started" by an interrupted up()', async () => {
      // Сбой посреди up() оставил маркер started; revert() не должен
      // вслепую выполнять down() по частично применённой схеме
      const mock = createStatefulExecutor();
      const runner = new YdbMigrationRunner(mock.executor);
      const broken = migrationFactory('1-Broken', {
        upError: new Error('boom'),
      });
      await expect(runner.run([broken.migration])).rejects.toThrow(
        /failed mid-way/,
      );
      expect([...mock.rows.values()][0].state).toBe('started');

      const m = migrationFactory('1-Broken');
      await expect(runner.revert([m.migration])).rejects.toThrow(
        /Cannot revert "1-Broken"[\s\S]*"started" state/,
      );
      expect(m.down).not.toHaveBeenCalled();

      // Запись не изменена: состояние разрешается только явно
      expect([...mock.rows.values()][0].state).toBe('started');
    });

    it('refuses to re-revert after a failed down() left "started"', async () => {
      // Первая попытка отката упала посреди down(): запись осталась started
      const mock = createStatefulExecutor({
        rows: [{ timestamp: 1000, name: '1-First' }],
      });
      const runner = new YdbMigrationRunner(mock.executor);
      const broken = migrationFactory('1-First', {
        downError: new Error('down failed'),
      });
      await expect(runner.revert([broken.migration])).rejects.toThrow(
        /Revert of "1-First" failed mid-way/,
      );

      // Повторный revert() отказывается вызывать down() ещё раз
      const retry = migrationFactory('1-First');
      await expect(
        new YdbMigrationRunner(mock.executor).revert([retry.migration]),
      ).rejects.toThrow(/Cannot revert "1-First"[\s\S]*"started" state/);
      expect(retry.down).not.toHaveBeenCalled();

      // После явного восстановления revert работает как обычно
      await runner.markMigrationApplied('1-First');
      const afterRepair = migrationFactory('1-First');
      const reverted = await new YdbMigrationRunner(mock.executor).revert([
        afterRepair.migration,
      ]);
      expect(reverted).toBe('1-First');
      expect(afterRepair.down).toHaveBeenCalledTimes(1);
      expect(mock.rows.size).toBe(0);
    });

    it('marks intent before down() and deletes the record after success', async () => {
      const mock = createStatefulExecutor({
        rows: [
          { timestamp: 1000, name: '1-First' },
          { timestamp: 2000, name: '2-Second' },
        ],
      });
      const runner = new YdbMigrationRunner(mock.executor);
      const m1 = migrationFactory('1-First');
      const m2 = migrationFactory('2-Second');

      const reverted = await runner.revert([m1.migration, m2.migration]);

      expect(reverted).toBe('2-Second');
      expect(m2.down).toHaveBeenCalled();
      expect(m1.down).not.toHaveBeenCalled();

      // Порядок: маркер намерения → down() → удаление записи
      const startIdx = mock.queries.findIndex((q) =>
        q.sql.startsWith('UPDATE'),
      );
      const downIdx = mock.queries.findIndex((q) => q.sql === 'DOWN 2-Second');
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeLessThan(downIdx);
      expect(
        mock.queries.find((q) => q.sql.startsWith('DELETE')),
      ).toBeDefined();
      expect(mock.rows.size).toBe(1); // осталась только 1-First
    });

    it('keeps the record when down() fails mid-way', async () => {
      const mock = createStatefulExecutor({
        rows: [{ timestamp: 1000, name: '1-Broken' }],
      });
      const runner = new YdbMigrationRunner(mock.executor);
      const broken = migrationFactory('1-Broken', {
        downError: new Error('down failed'),
      });

      await expect(runner.revert([broken.migration])).rejects.toThrow(
        /Revert of "1-Broken" failed mid-way/,
      );
      expect(broken.down).toHaveBeenCalledTimes(1);

      // Запись не молча осталась «применённой»: состояние started
      const [row] = [...mock.rows.values()];
      expect(row.name).toBe('1-Broken');
      expect(row.state).toBe('started');
    });

    it('keeps the record when the delete after down() fails', async () => {
      // Раньше: down() прошёл, DELETE записи упал — миграция оставалась
      // recorded как применённая, хотя схема уже откачена.
      const mock = createStatefulExecutor({
        rows: [{ timestamp: 1000, name: '1-Reverted' }],
        failOn: (sql) =>
          sql.startsWith('DELETE') ? new Error('DELETE failed') : undefined,
      });
      const runner = new YdbMigrationRunner(mock.executor);
      const m = migrationFactory('1-Reverted');

      await expect(runner.revert([m.migration])).rejects.toThrow(
        /DELETE failed/,
      );

      const [row] = [...mock.rows.values()];
      expect(row.name).toBe('1-Reverted');
      expect(row.state).toBe('started');
      expect(m.down).toHaveBeenCalledTimes(1);
    });

    it('returns null when there is nothing to revert', async () => {
      const runner = new YdbMigrationRunner(createStatefulExecutor().executor);

      expect(
        await runner.revert([migrationFactory('1-First').migration]),
      ).toBeNull();
    });

    it('fails to revert when the migration file is missing', async () => {
      const mock = createStatefulExecutor({
        rows: [{ timestamp: 1000, name: '1-Ghost', hash: sha256('ghost') }],
      });
      const runner = new YdbMigrationRunner(mock.executor);

      await expect(
        runner.revert([migrationFactory('2-Other').migration]),
      ).rejects.toThrow(/Migration file for "1-Ghost" not found/);
    });
  });

  describe('status', () => {
    it('reports pending/applied/interrupted migrations', async () => {
      const mock = createStatefulExecutor({
        rows: [
          { timestamp: 1000, name: '1-First' },
          { timestamp: 2000, name: '2-Interrupted', state: 'started' },
        ],
      });
      const runner = new YdbMigrationRunner(mock.executor);

      const statuses = await runner.status([
        migrationFactory('1-First').migration,
        migrationFactory('2-Interrupted').migration,
        migrationFactory('3-Pending').migration,
      ]);

      expect(statuses).toEqual([
        {
          name: '1-First',
          applied: true,
          appliedAt: new Date(1000),
          interrupted: false,
        },
        {
          name: '2-Interrupted',
          applied: true,
          appliedAt: new Date(2000),
          interrupted: true,
        },
        { name: '3-Pending', applied: false },
      ]);
    });

    it('reports orphan records for applied migrations without files', async () => {
      const mock = createStatefulExecutor({
        rows: [{ timestamp: 3000, name: '900-DeletedFile' }],
      });
      const runner = new YdbMigrationRunner(mock.executor);

      const statuses = await runner.status([
        migrationFactory('1-Alive').migration,
      ]);

      expect(statuses).toEqual([
        { name: '1-Alive', applied: false },
        {
          name: '900-DeletedFile',
          applied: true,
          appliedAt: new Date(3000),
          orphan: true,
          interrupted: false,
        },
      ]);
    });

    it('marks a record whose content changed after apply (#152)', async () => {
      // Запись учёта осталась от старого содержимого; файл миграции
      // теперь с другим хешем — сопоставление по имени даёт 'changed'.
      const mock = createStatefulExecutor({
        rows: [
          {
            timestamp: 5000,
            name: '1-Edited',
            hash: sha256('original content'),
          },
        ],
      });
      const runner = new YdbMigrationRunner(mock.executor);

      const statuses = await runner.status([
        migrationFactory('1-Edited', { hash: sha256('tampered') }).migration,
      ]);

      expect(statuses).toEqual([
        {
          name: '1-Edited',
          applied: true,
          appliedAt: new Date(5000),
          interrupted: false,
          contentChanged: true,
        },
      ]);
    });

    it('does not set contentChanged when hashes match (#152)', async () => {
      const hash = sha256('same');
      const mock = createStatefulExecutor({
        rows: [{ timestamp: 6000, name: '1-Same', hash }],
      });
      const runner = new YdbMigrationRunner(mock.executor);

      const statuses = await runner.status([
        migrationFactory('1-Same', { hash }).migration,
      ]);

      expect(statuses).toEqual([
        {
          name: '1-Same',
          applied: true,
          appliedAt: new Date(6000),
          interrupted: false,
          contentChanged: undefined,
        },
      ]);
    });
  });

  it('runs pending migrations in order and records stable identity', async () => {
    const hashA = sha256('a');
    const hashB = sha256('b');
    const mock = createStatefulExecutor();
    const runner = new YdbMigrationRunner(mock.executor);
    const m1 = migrationFactory('1-First', { hash: hashA });
    const m2 = migrationFactory('2-Second', { hash: hashB });

    const executed = await runner.run([m1.migration, m2.migration]);

    expect(executed).toEqual(['1-First', '2-Second']);
    expect(m1.up).toHaveBeenCalled();
    expect(m2.up).toHaveBeenCalled();

    const inserts = insertQueries(mock);
    expect(inserts).toHaveLength(2);
    // id детерминирован хешем содержимого
    expect(String(inserts[0].params.id.value)).toBe(
      String(deriveMigrationRowId(hashA)),
    );
    expect(String(inserts[1].params.id.value)).toBe(
      String(deriveMigrationRowId(hashB)),
    );
    expect(inserts[0].params.hash.value).toBe(hashA);
    expect(String(inserts[0].params.state.value)).toBe('started');
  });

  it('throws when migration has no name and no hash', async () => {
    const runner = new YdbMigrationRunner(createStatefulExecutor().executor);
    const nameless: YdbMigration = {
      up: jest.fn(async () => {}),
      down: jest.fn(async () => {}),
    };

    await expect(runner.run([nameless])).rejects.toThrow(/has no name/);
  });
});
