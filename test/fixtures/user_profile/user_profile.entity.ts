// user_profile/user_profile.entity.ts
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  OneToOne,
  EagerLoad,
} from '../../../src/index.js';
import { UserEntity } from '../user/user.entity.js';

@YdbEntity('user_profiles')
@EagerLoad(['user'])
export class UserProfileEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Uuid')
  user_uuid: string;

  @YdbColumn('Utf8')
  bio: string;

  @OneToOne(() => UserEntity, 'user_uuid')
  user?: UserEntity;

  static async findByUuid(uuid: string) {
    return this.find({ uuid });
  }
}
