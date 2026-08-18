import {
  createE2eContext,
  closeE2eContext,
  hasYdbCredentials,
  createTableForEntity,
  dropTableForEntity,
  type E2eContext,
} from './setup.js';
import {
  E2eOrderEntity,
  E2eOrderItemEntity,
  E2eUserEntity,
  E2eProfileEntity,
} from './entities.js';

let ctx: E2eContext | null = null;

beforeAll(async () => {
  ctx = await createE2eContext();
  if (!ctx) return;

  for (const Entity of [E2eOrderEntity, E2eOrderItemEntity, E2eUserEntity, E2eProfileEntity]) {
    await createTableForEntity(ctx.executor, Entity);
  }

  E2eOrderEntity.setExecutor(ctx.executor);
  E2eOrderItemEntity.setExecutor(ctx.executor);
  E2eUserEntity.setExecutor(ctx.executor);
  E2eProfileEntity.setExecutor(ctx.executor);
});

afterAll(async () => {
  if (!ctx) return;
  for (const Entity of [E2eProfileEntity, E2eUserEntity, E2eOrderItemEntity, E2eOrderEntity]) {
    await dropTableForEntity(ctx.executor, Entity);
  }
  E2eOrderEntity.setExecutor(undefined as any);
  E2eOrderItemEntity.setExecutor(undefined as any);
  E2eUserEntity.setExecutor(undefined as any);
  E2eProfileEntity.setExecutor(undefined as any);
  await closeE2eContext(ctx);
});

const describeE2e = () => (hasYdbCredentials() ? describe : describe.skip);

describeE2e()('Relations e2e', () => {
  describe('OneToMany + EagerLoad', () => {
    it('eagerly loads child entities via @OneToMany', async () => {
      const order = new E2eOrderEntity();
      order.customer = 'Test Customer';
      order.total = 30;
      await E2eOrderEntity.save(order);

      const item1 = new E2eOrderItemEntity();
      item1.order_uuid = order.uuid;
      item1.product = 'Item A';
      item1.qty = 2;
      await E2eOrderItemEntity.save(item1);

      const item2 = new E2eOrderItemEntity();
      item2.order_uuid = order.uuid;
      item2.product = 'Item B';
      item2.qty = 1;
      await E2eOrderItemEntity.save(item2);

      // EagerLoad should populate items automatically
      const found = await E2eOrderEntity.find({ uuid: order.uuid });
      expect(found).not.toBeNull();
      expect(found!.customer).toBe('Test Customer');
      expect(found!.items).toBeDefined();
      expect(found!.items!.length).toBe(2);

      const products = found!.items!.map((i) => i.product).sort();
      expect(products).toEqual(['Item A', 'Item B']);
    });
  });

  describe('ManyToOne', () => {
    it('stores foreign key and loads parent via loadRelations', async () => {
      const order = new E2eOrderEntity();
      order.customer = 'FK Test';
      order.total = 50;
      await E2eOrderEntity.save(order);

      const item = new E2eOrderItemEntity();
      item.order_uuid = order.uuid;
      item.product = 'FK Item';
      item.qty = 5;
      await E2eOrderItemEntity.save(item);

      const found = await E2eOrderItemEntity.find({ uuid: item.uuid });
      expect(found).not.toBeNull();
      expect(found!.order_uuid).toBe(order.uuid);
    });
  });

  describe('OneToOne', () => {
    it('stores foreign key and loads related entity', async () => {
      const user = new E2eUserEntity();
      user.name = 'Profile User';
      await E2eUserEntity.save(user);

      const profile = new E2eProfileEntity();
      profile.user_uuid = user.uuid;
      profile.bio = 'Test bio';
      await E2eProfileEntity.save(profile);

      const foundProfile = await E2eProfileEntity.find({
        uuid: profile.uuid,
      });
      expect(foundProfile).not.toBeNull();
      expect(foundProfile!.user_uuid).toBe(user.uuid);
      expect(foundProfile!.bio).toBe('Test bio');
    });
  });
});
