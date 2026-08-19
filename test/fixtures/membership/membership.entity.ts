// membership/membership.entity.ts
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  ManyToOne,
} from '../../../src/index.js';
import { UserEntity } from '../user/user.entity.js';

/**
 * Тестовая сущность с составным PK разных типов (Utf8 + Uuid)
 * и relation many-to-one (FK = один из компонентов PK).
 */
@YdbEntity('memberships')
export class MembershipEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant_id: string;

  @YdbPrimaryColumn('Uuid')
  user_uuid: string;

  @YdbColumn('Utf8')
  role?: string;

  @ManyToOne(() => UserEntity, (membership) => membership.user_uuid)
  user?: UserEntity;
}
