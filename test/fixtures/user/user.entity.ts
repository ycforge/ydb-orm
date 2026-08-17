// user/user.entity.ts
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  OneToMany,
  EagerLoad,
  YdbEncrypted,
} from '../../../src/index.js';
import { UserRoleEntity } from '../user_role/user_role.entity.js';

@YdbEntity('users')
@EagerLoad(['userRoles'])
export class UserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbEncrypted()
  @YdbColumn('Utf8')
  email_encrypted: string;

  @YdbEncrypted({ blindIndex: false })
  @YdbColumn('Utf8')
  full_name: string;

  @OneToMany(() => UserRoleEntity, (user_role) => user_role.user_uuid)
  userRoles?: UserRoleEntity[];

  static async findByEmail(email: string) {
    // Поиск по blind index: колонка email_encrypted_bi
    return this.find({ email_encrypted: email });
  }

  static async findByUuid(uuid: string) {
    return this.find({ uuid });
  }
}
