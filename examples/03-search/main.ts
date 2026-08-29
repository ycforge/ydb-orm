/**
 * Пример 03: поиск и выборки.
 *
 * find / findOneBy (одна строка или null), findAll / findBy (список),
 * count (количество), фильтры по нескольким полям сразу и пагинация
 * через QueryOptions { limit, offset }.
 *
 * По умолчанию limit = 100 строк, максимум — 1000.
 */
import { UserEntity } from '../shared/entities/index.js';
import { connectToYdb } from '../shared/setup.js';

async function main(): Promise<void> {
  const { driver } = await connectToYdb([UserEntity]);

  try {
    // Готовим данные: нескольких пользователей одной организации.
    const ivan = new UserEntity();
    ivan.name = 'Иван';
    ivan.email = 'ivan@example.com';
    ivan.organization = 'acme';
    await UserEntity.save(ivan);

    const petr = new UserEntity();
    petr.name = 'Пётр';
    petr.email = 'petr@example.com';
    petr.organization = 'acme';
    await UserEntity.save(petr);

    const ann = new UserEntity();
    ann.name = 'Анна';
    ann.email = 'ann@example.com';
    ann.organization = 'other';
    await UserEntity.save(ann);

    // --- find(): одна строка или null (LIMIT 1). ---
    const byPk = await UserEntity.find({ uuid: ivan.uuid });
    console.log('find по PK:', byPk?.name);

    // --- findOneBy(): то же, но с акцентом на «первую попавшуюся». ---
    const byName = await UserEntity.findOneBy({ name: 'Пётр' });
    console.log('findOneBy по имени:', byName?.name, byName?.organization);

    // --- findAll(): список с фильтром по нескольким полям. ---
    const acmeUsers = await UserEntity.findAll({ organization: 'acme' });
    console.log(
      'findAll(organization=acme):',
      acmeUsers.map((u) => u.name),
    );

    // --- findBy(): дубликат findAll, полезен как парный к findOneBy. ---
    const byOrg = await UserEntity.findBy({ organization: 'acme' });
    console.log('findBy(organization=acme):', byOrg.length);

    // --- count(): количество строк. ---
    console.log('count(all):', await UserEntity.count({}));
    console.log(
      'count(organization=acme):',
      await UserEntity.count({ organization: 'acme' }),
    );

    // --- Пагинация через QueryOptions: limit + offset. ---
    const page1 = await UserEntity.findAll({}, { limit: 2, offset: 0 });
    const page2 = await UserEntity.findAll({}, { limit: 2, offset: 2 });
    console.log(
      'Страница 1:',
      page1.map((u) => u.name),
    );
    console.log(
      'Страница 2:',
      page2.map((u) => u.name),
    );

    // Чистим данные: deleteBy не допускает пустое условие, поэтому
    // удаляем по конкретным ключам; очистка всей таблицы — намеренный
    // шаг вне примеров (см. deleteBy в примере 02).
    for (const u of [ivan, petr, ann]) {
      await UserEntity.delete(u.uuid);
    }
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
