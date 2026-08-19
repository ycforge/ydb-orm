import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEncrypted,
  OneToMany,
  OneToOne,
  EagerLoad,
} from '../../src/index.js';

@YdbEntity('e2e_items')
export class E2eItemEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;

  @YdbColumn('Int32')
  quantity!: number;

  @YdbColumn('Double')
  price!: number;

  @YdbColumn('Bool')
  active!: boolean;

  @YdbColumn('Int64')
  total_views!: bigint;

  @YdbColumn('Utf8')
  description!: string;
}

@YdbEntity('e2e_secrets')
export class E2eSecretEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbEncrypted({ blindIndex: true })
  email!: string;

  @YdbEncrypted({ blindIndex: false })
  notes!: string;

  @YdbColumn('Utf8')
  plaintext!: string;
}

@YdbEntity('e2e_order_items')
export class E2eOrderItemEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Uuid')
  order_uuid!: string;

  @YdbColumn('Utf8')
  product!: string;

  @YdbColumn('Int32')
  qty!: number;
}

@YdbEntity('e2e_orders')
@EagerLoad(['items'])
export class E2eOrderEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  customer!: string;

  @YdbColumn('Int32')
  total!: number;

  @OneToMany(() => E2eOrderItemEntity, (item) => item.order_uuid)
  items?: E2eOrderItemEntity[];
}

@YdbEntity('e2e_users')
export class E2eUserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;

  @YdbColumn('Uuid')
  profile_uuid?: string;
}

@YdbEntity('e2e_profiles')
export class E2eProfileEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Uuid')
  user_uuid!: string;

  @YdbColumn('Utf8')
  bio!: string;

  @OneToOne(() => E2eUserEntity, 'user_uuid')
  user?: E2eUserEntity;
}
