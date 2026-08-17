/**
 * Сущность пользователя: relations, шифрование полей с blind index,
 * AAD и eager-загрузка.
 *
 *  - email — шифруется с blind index ({blindIndex: true} по умолчанию),
 *    по нему можно искать через find/findAll (hash значения).
 *  - government_id — шифруется БЕЗ blind index: хранится только ciphertext,
 *    поиск по нему невозможен.
 *  - organization — незашифрованное поле, участвует в AAD (Additional
 *    Authenticated Data) при шифровании остальных полей.
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbEncrypted,
  YdbSecurityAAD,
  YdbBaseEntity,
  OneToMany,
  OneToOne,
  EagerLoad,
} from '../../src/index.js';
import { PostEntity } from './post.entity.js';
import { ProfileEntity } from './profile.entity.js';

@YdbEntity('users')
@EagerLoad(['posts', 'profile'])
export class UserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbSecurityAAD()
  @YdbColumn('Utf8')
  organization: string;

  @YdbEncrypted({ blindIndex: true })
  @YdbColumn('Utf8')
  email: string;

  @YdbEncrypted({ blindIndex: false })
  @YdbColumn('Utf8')
  government_id: string;

  // join column — FK на стороне Target (PostEntity.user_uuid).
  @OneToMany(() => PostEntity, (post) => post.user_uuid)
  posts?: PostEntity[];

  // Owning-сторона one-to-one: User хранит FK на Profile.
  @YdbColumn('Uuid')
  profile_uuid: string;

  // join column — FK на текущей (owning) сущности: UserEntity.profile_uuid.
  @OneToOne(() => ProfileEntity, (user) => user.profile_uuid)
  profile?: ProfileEntity;

  static async findByEmail(email: string) {
    // Поиск по blind index: значение хэшируется и сравнивается с {field}_bi
    return this.find({ email });
  }
}
