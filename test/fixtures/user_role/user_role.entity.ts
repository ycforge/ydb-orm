// user_role.entity.ts
import {
  YdbEntity,
  YdbPrimaryColumn,
  YdbColumn,
  YdbBaseEntity,
} from '../../../src/index.js';

@YdbEntity('user_roles')
export class UserRoleEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  user_uuid: string;

  @YdbPrimaryColumn('Uuid')
  role_uuid: string;

  @YdbPrimaryColumn('Uuid')
  organization_uuid: string;

  @YdbColumn('Bool')
  is_global: boolean;
}
