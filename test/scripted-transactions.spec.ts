import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { createAuth } from '@ycforge/auth';
import { YdbTransactionManager } from '../src/index.js';
import {
  YdbCoreModule,
  YdbOrmModule,
  YDB_DRIVER,
  YDB_QUERY,
} from '../src/nest/index.js';
import { createScriptedExecutor } from './helpers/ydb-mock.js';
import { unavailableError } from './helpers/ydb-responses.js';
import type { ScriptedMockExecutor } from './helpers/ydb-mock.js';
import {
  OrderStatusEntity,
  OrderStatus,
} from './fixtures/enum_order/order-status.entity.js';

/**
 * Семантика commit/rollback на уровне мока (#109): не счётчики вызовов,
 * а точная последовательность begin → шаги → commit | rollback.
 *
 * Старый one-shot мок не моделировал транзакции вовсе (execute просто
 * вызывал колбэк), поэтому «операции после отката не закоммичены»
 * проверить было нельзя.
 */

const UUID_A = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';
const UUID_B = '6ad91505-d4f6-4a81-ab65-9dbc68cf4ed6';

@Module({
  imports: [YdbOrmModule.forFeature([OrderStatusEntity])],
})
class OrdersFeatureModule {}

async function createTestingModule(db: ScriptedMockExecutor) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      YdbCoreModule.forRootAsync({
        useFactory: () => ({
          endpoint: 'grpc://localhost:2136/local',
          auth: createAuth({ type: 'anonymous' }),
          sync: false,
        }),
      }),
      OrdersFeatureModule,
    ],
  })
    .overrideProvider(YDB_DRIVER)
    .useValue({})
    .overrideProvider(YDB_QUERY)
    .useValue(db.executor)
    .compile();

  return {
    moduleRef,
    txManager: moduleRef.get(YdbTransactionManager),
  };
}

function newOrder(status: OrderStatus): OrderStatusEntity {
  // Без PK: save() идёт по пути INSERT → UPSERT INTO
  const order = new OrderStatusEntity();
  order.title = 'order';
  order.status = status;
  return order;
}

function existingOrder(): OrderStatusEntity {
  // С PK: save() идёт по пути UPDATE ... RETURNING * — строку вернёт мок
  const order = new OrderStatusEntity();
  order.uuid = UUID_B;
  order.title = 'b';
  order.status = OrderStatus.SHIPPED;
  return order;
}

describe('#109: транзакции через DI: точная семантика на программном моке', () => {
  let db: ScriptedMockExecutor;
  let moduleRef: Awaited<ReturnType<typeof createTestingModule>>['moduleRef'];
  let txManager: YdbTransactionManager;

  beforeEach(async () => {
    db = createScriptedExecutor({ label: 'orders-db' });
    ({ moduleRef, txManager } = await createTestingModule(db));
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('успешная транзакция: begin → UPSERT внутри trx → commit; запись вне транзакции идёт в base', async () => {
    // Сценарий: одна запись в транзакции, затем чтение вне её.
    db.expect('UPSERT INTO `fixture_orders`').inTransaction().returns([]);
    db.expect('SELECT COUNT(*)').outsideTransaction().returnsRows({ cnt: 1 });

    await txManager.runInTransaction(async (trx) => {
      const order = newOrder(OrderStatus.NEW);
      await OrderStatusEntity.save(order, { trx });
    });

    await OrderStatusEntity.count({});

    // Точная последовательность событий жизненного цикла
    expect(db.transactionEvents.map((e) => e.type)).toEqual([
      'begin',
      'commit',
    ]);

    // Запись исполнилась ВНУТРИ транзакции, чтение — вне её
    expect(db.calls[0].scope).toBe(db.transactionEvents[0].label);
    expect(db.calls[0].sql).toContain('UPSERT INTO `fixture_orders`');
    expect(db.calls[1].scope).toBe('base');

    db.assertComplete();
  });

  it('сбой записи: begin → rollback, коммита нет; операции после отката уходят в base', async () => {
    db.expect('UPSERT INTO `fixture_orders`')
      .inTransaction()
      .throws(unavailableError());
    db.expect('SELECT COUNT(*)').outsideTransaction().returnsRows({ cnt: 0 });

    await expect(
      txManager.runInTransaction(async (trx) => {
        const order = newOrder(OrderStatus.PAID);
        await OrderStatusEntity.save(order, { trx });
      }),
    ).rejects.toThrow('session unavailable');

    // Роллбак зафиксирован событием, а коммита НЕТ
    expect(db.transactionEvents.map((e) => e.type)).toEqual([
      'begin',
      'rollback',
    ]);
    expect(
      db.transactionEvents.filter((e) => e.type === 'commit'),
    ).toHaveLength(0);

    // После отката операция выполняется уже ВНЕ транзакции:
    // контекст очищен, «записи» откатившейся транзакции нигде не закоммичены
    await OrderStatusEntity.count({});
    expect(db.calls[1].scope).toBe('base');

    db.assertComplete();
  });

  it('откат не мешает следующей транзакции: вторая транзакция коммитится со своими шагами', async () => {
    const failure = unavailableError();
    db.expect('UPSERT INTO `fixture_orders`').inTransaction().throws(failure);
    db.expect('SELECT `uuid`, `title`, `status` FROM `fixture_orders`')
      .inTransaction()
      .returnsRows({ uuid: UUID_B, title: 'b', status: 1 });
    db.expect(/UPDATE `fixture_orders`/)
      .inTransaction()
      .returnsRows({ uuid: UUID_B, title: 'b', status: 2 });

    // Первая транзакция падает и откатывается
    await expect(
      txManager.runInTransaction(async (trx) => {
        await OrderStatusEntity.save(newOrder(OrderStatus.NEW), { trx });
      }),
    ).rejects.toBe(failure);

    // Вторая транзакция: чтение + запись — успешно коммитится
    await txManager.runInTransaction(async (trx) => {
      const found = await OrderStatusEntity.find({ uuid: UUID_B }, { trx });
      expect(found?.status).toBe('paid'); // Int32 enum конвертирован из индекса
      const updated = await OrderStatusEntity.save(existingOrder(), { trx });
      expect(updated.status).toBe(OrderStatus.SHIPPED);
    });

    const types = db.transactionEvents.map((e) => e.type);
    expect(types).toEqual(['begin', 'rollback', 'begin', 'commit']);
    // Разные транзакции — разные метки/сессии
    const labels = db.transactionEvents
      .filter((e) => e.type === 'begin')
      .map((e) => e.label);
    expect(labels[0]).not.toBe(labels[1]);

    // Порядок SQL строго как в сценарии: упавший upsert, select, затем update
    expect(db.calls.map((c) => c.sql.trimStart().slice(0, 6))).toEqual([
      'UPSERT',
      'SELECT',
      'UPDATE',
    ]);
    // Все три шага исполнились в своих транзакциях, ни один — в base
    expect(db.calls.every((c) => c.scope !== 'base')).toBe(true);

    db.assertComplete();
  });

  it('ошибка прикладной логики после успешных запросов откатывает транзакцию', async () => {
    db.expect('UPSERT INTO `fixture_orders`').inTransaction().returns([]);

    const boom = new Error('domain rule violated');
    await expect(
      txManager.runInTransaction(async (trx) => {
        await OrderStatusEntity.save(newOrder(OrderStatus.CANCELLED), { trx });
        throw boom;
      }),
    ).rejects.toBe(boom);

    // Запрос исполнен, но транзакция завершена rollback — записей нет
    expect(db.calls).toHaveLength(1);
    expect(db.transactionEvents.map((e) => e.type)).toEqual([
      'begin',
      'rollback',
    ]);
  });

  it('AbortSignal наблюдаем: пред-абортнутый сигнал роняет запрос до обращения к БД', async () => {
    const controller = new AbortController();
    controller.abort();

    db.expect(
      'SELECT `uuid`, `title`, `status` FROM `fixture_orders`',
    ).returnsRows({
      uuid: UUID_A,
      title: 'x',
      status: 0,
    });

    await expect(
      OrderStatusEntity.findAll({}, { signal: controller.signal }),
    ).rejects.toThrow('Query aborted by signal');

    // Запрос был ПОСТРОЕН (записан), но не отправлен: у реального SDK Query
    // исполнение ленивое, а executeQuery проверяет сигнал до await.
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].awaited).toBe(false);

    // Шаг сценария остался неистребованным — это ловит assertComplete
    expect(() => db.assertComplete()).toThrow(/never executed/);
  });

  it('timeout из QueryOptions доходит до SDK-слоя и наблюдаем на записанном вызове', async () => {
    db.expect('SELECT COUNT(*)').outsideTransaction().returnsRows({ cnt: 3 });

    await OrderStatusEntity.count({}, { timeout: 1500 });

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].timeoutMs).toBe(1500);
    expect(db.calls[0].scope).toBe('base');
  });

  it('insertMany с Int32-enum внутри транзакции: один UPSERT, ординальные индексы в параметрах', async () => {
    db.expect('UPSERT INTO `fixture_orders`').inTransaction().returns([]);

    const rows = [
      newOrder(OrderStatus.NEW),
      existingOrder(), // PK задан → insertMany всё равно пишет все поля как есть
    ];
    await txManager.runInTransaction(async (trx) => {
      await OrderStatusEntity.insertMany(rows, { trx });
    });

    expect(db.transactionEvents.map((e) => e.type)).toEqual([
      'begin',
      'commit',
    ]);
    expect(db.calls).toHaveLength(1);
    // Enum конвертирован в ординальные индексы по строкам
    const raw = (v: unknown): unknown =>
      v && typeof v === 'object' && 'value' in (v as any)
        ? (v as any).value
        : v;
    expect(raw(db.calls[0].params['status_0'])).toBe(0); // NEW
    expect(raw(db.calls[0].params['status_1'])).toBe(2); // SHIPPED

    db.assertComplete();
  });
});
