/**
 * Пример 02: полный CRUD поверх Active Record.
 *
 * Показаны insert (save без PK), update (save с PK), массовая вставка
 * (insertMany), updateBy / deleteBy (обновление и удаление по условию),
 * delete по PK и count.
 */
import { UserEntity } from '../shared/entities/index.js';
import { connectToYdb } from '../shared/setup.js';

async function main(): Promise<void> {
  const { driver } = await connectToYdb([UserEntity]);

  try {
    // --- INSERT ---
    const alice = new UserEntity();
    alice.name = 'Алиса';
    alice.email = 'alice@example.com';
    alice.organization = 'acme';
    await UserEntity.save(alice); // uuid сгенерируется автоматически (v7)
    console.log('INSERT:', alice.uuid);

    // --- UPDATE по PK: выбираем сохранённую запись и меняем поля ---
    alice.organization = 'globex';
    const saved = await UserEntity.save(alice); // PK есть -> UPDATE
    console.log('UPDATE:', saved.organization);

    // --- Массовая вставка: батчи по 100 строк ---
    const batch = Array.from({ length: 3 }, () => {
      const u = new UserEntity();
      u.name = 'Аноним';
      u.email = `anon-${Math.random().toString(36).slice(2)}@example.com`;
      u.organization = 'acme';
      return u;
    });
    await UserEntity.insertMany(batch);
    console.log('insertMany:', batch.length, 'строк');

    // --- updateBy: обновить все строки, удовлетворяющие условию ---
    // (поле в where не должно пересекаться с полями patch)
    const updatedCount = await UserEntity.updateBy(
      { organization: 'acme' },
      { name: 'Из Алисы' },
    );
    console.log('updateBy затронул:', updatedCount, 'строк');

    // --- count: количество строк по критерию ---
    console.log('name=Из Алисы:', await UserEntity.count({ name: 'Из Алисы' }));

    // --- deleteBy: удалить по условию ---
    const deletedCount = await UserEntity.deleteBy({ name: 'Из Алисы' });
    console.log('deleteBy удалил:', deletedCount, 'строк');

    // --- delete по PK ---
    const removed = await UserEntity.delete(alice.uuid);
    console.log('delete по PK вернул удалённую строку:', Boolean(removed));
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
