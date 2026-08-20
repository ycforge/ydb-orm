import 'reflect-metadata';
// Примеры импортов — подставьте реальные пути/импорт из вашей сборки
import { YdbEntity } from '../../src/decorators/entity.decorator.js';
import { YdbColumn, YdbPrimaryColumn } from '../../src/decorators/column.decorator.js';
import { YdbBaseEntity } from '../../src/entity/base-entity.js';

@YdbEntity('orders')
class OrderEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  customer: string;

  @YdbColumn('Double')
  amount: number;
}

@YdbEntity('outbox_events')
class OutboxEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  topic: string;

  @YdbColumn('Utf8')
  payload: string; // JSON string

  @YdbColumn('Bool')
  sent: boolean;

  @YdbColumn('Timestamp')
  created_at: string;
}

// Пример сервиса: создаёт заказ и событие outbox в одной транзакции
export async function createOrderWithOutbox(orderData: Partial<OrderEntity>, event: { topic: string; payload: any }) {
  // Получите executor / транзакцию из рантайма. API транзакций зависит от вашей конфигурации.
  // Здесь показано псевдо-API: beginTransaction() -> tx -> commit/rollback
  const exec = OrderEntity.getExecutor();

  // Псевдо-код: если у вас есть реальная транзакционная обёртка — используйте её
  const tx = await exec.beginTransaction?.();
  try {
    const order = new OrderEntity();
    order.uuid = OrderEntity.generateUuid();
    order.customer = orderData.customer!;
    order.amount = orderData.amount!;

    // Сохраняем заказ (вставка/обновление) с передачей trx/tx в опциях
    await order.save({ trx: tx });

    // Добавляем запись в outbox
    const out = new OutboxEntity();
    out.uuid = OutboxEntity.generateUuid();
    out.topic = event.topic;
    out.payload = JSON.stringify(event.payload);
    out.sent = false;
    out.created_at = new Date().toISOString();

    await out.insert({ trx: tx });

    // Коммит транзакции
    await tx?.commit?.();
  } catch (err) {
    await tx?.rollback?.();
    throw err;
  }
}

// Простая dispatcher-функция: читает несent-ивые события, отправляет и помечает как sent
export async function dispatchOutboxBatch(batchSize = 10) {
  const exec = OutboxEntity.getExecutor();

  // Читаем batch несent-ивых событий
  const rows = await OutboxEntity.findAll({ sent: false }, { limit: batchSize, offset: 0 });

  for (const r of rows) {
    try {
      // Симулируем отправку: HTTP, очереди и т.д.
      const payload = JSON.parse(r.payload as unknown as string);
      await sendToExternalSystem(r.topic, payload);

      // Помечаем как отправленное
      await OutboxEntity.updateBy({ uuid: r.uuid }, { sent: true });
    } catch (err) {
      // Логируем и продолжим — можно внедрить retry/backoff
      console.error('Failed to dispatch outbox event', r.uuid, err);
    }
  }
}

async function sendToExternalSystem(topic: string, payload: any) {
  // Замените этим реальную интеграцию
  console.log('Sending', topic, payload);
}
