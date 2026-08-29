/**
 * Пример 11: продвинутые возможности одним файлом.
 *
 * Показаны:
 *  - вторичные индексы (@YdbIndex): поиск по индексированной колонке;
 *  - enum (@YdbEnum, storage Int32) и даты (@YdbCreateDateColumn);
 *  - JSON-колонки (@YdbJson) + JSON_VALUE через Query Builder;
 *  - TTL (@YdbTtl): таблица с автопростроителем удаления старых строк;
 *  - lifecycle-хуки (локальная сущность AuditEventEntity).
 */
import { getOrCreateRepository } from '../../src/index.js';
import {
  ArticleEntity,
  OrderEntity,
  OrderStatus,
  ProductEntity,
  TtlDocEntity,
} from '../shared/entities/index.js';
import { connectToYdb } from '../shared/setup.js';
import { AuditEventEntity } from './audit-event.entity.js';

async function main(): Promise<void> {
  const { driver } = await connectToYdb([
    ArticleEntity,
    OrderEntity,
    ProductEntity,
    TtlDocEntity,
    AuditEventEntity,
  ]);

  try {
    // --- Вторичные индексы: WHERE по индексированной колонке ---
    const article = new ArticleEntity();
    article.slug = 'about-ydb';
    article.title = 'Про YDB';
    article.author = 'max';
    article.body = '...';
    article.created_at = new Date();
    await ArticleEntity.save(article);

    const found = await ArticleEntity.find({ slug: 'about-ydb' });
    console.log('Статья по индексу slug:', found?.title);

    // --- Enum: в БД хранится порядковый номер, в объекте — значение ---
    const order = new OrderEntity();
    order.customer = 'Анна';
    order.amount = 1250.5;
    order.status = OrderStatus.PAID;
    order.placed_at = new Date();
    await OrderEntity.save(order);

    const orderFromDb = await OrderEntity.find({ uuid: order.uuid });
    console.log(
      'Статус заказа (enum):',
      orderFromDb?.status,
      '(в БД:',
      orderFromDb?.status.valueOf(),
      ')',
    );
    const paidOrders = await OrderEntity.findAll({ status: OrderStatus.PAID });
    console.log('Оплаченных заказов:', paidOrders.length);

    // --- JSON-колонка + JSON_VALUE из Query Builder ---
    const product = new ProductEntity();
    product.name = 'Кофеварка';
    product.price = 1999.0;
    product.stock = 5;
    product.attributes = { color: 'black', size: 'L' };
    await ProductEntity.save(product);

    try {
      // Параметризованный путь: работает на полноценном YDB. Локальный
      // эмулятор требует литерал, поэтому его результат выше с try/catch.
      const byColor = await getOrCreateRepository(ProductEntity)
        .query()
        .andWhereJsonValue('attributes', '$.color', 'black')
        .getMany();
      console.log('Товары с цветом black (JSON_VALUE):', byColor.length);
    } catch (error) {
      console.log(
        'Локальный эмулятор не исполняет параметризованный JSON-путь:',
        (error as Error).message.split('\n')[0],
      );
      // Рабочий фолбэк на эмуляторе — фильтрация на стороне JS.
      const all = await ProductEntity.findAll();
      const byColor = all.filter((p) => p.attributes?.color === 'black');
      console.log('Товары с цветом black (JS-фильтр):', byColor.length);
    }

    // --- TTL: expires_at в прошлом -> строка удалится фоновым процессом ---
    const expiring = new TtlDocEntity();
    expiring.body = 'скоро исчезнет';
    expiring.expires_at = new Date(Date.now() - 24 * 3600 * 1000);
    await TtlDocEntity.save(expiring);
    console.log('TTL-документ сохранён, таблица с TTL = P7D');

    // --- Lifecycle-хуки (см. AuditEventEntity) ---
    const audit = new AuditEventEntity();
    audit.name = 'первое событие';
    await AuditEventEntity.save(audit);
    console.log('note после insert (хук):', audit.note.startsWith('created@'));

    audit.name = 'обновлён';
    await AuditEventEntity.save(audit); // UPDATE по PK
    console.log('note после update (хук):', audit.note.startsWith('updated@'));

    const readBack = await AuditEventEntity.find({ uuid: audit.uuid });
    console.log(
      'note после find (хук):',
      readBack?.note.endsWith('[прочитано]'),
    );

    await AuditEventEntity.deleteBy({ uuid: audit.uuid }); // @BeforeRemove

    // --- Чистим остальное (по конкретным ключам; deleteBy({}) запрещён) ---
    await ArticleEntity.deleteBy({ slug: 'about-ydb' });
    await OrderEntity.deleteBy({ uuid: order.uuid });
    await ProductEntity.deleteBy({ uuid: product.uuid });
    await TtlDocEntity.deleteBy({ uuid: expiring.uuid });
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
