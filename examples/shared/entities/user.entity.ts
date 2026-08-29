/**
 * Пользователь — центральная сущность примеров.
 *
 * Отношения:
 *  - один пользователь -> много постов (PostEntity.user_uuid);
 *  - один пользователь -> один профиль (FK UserEntity.profile_uuid).
 *
 * Eager-загрузка в этом примере специально не включается: relations
 * подгружаются явно через loadRelations (см. пример 04-relations).
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbCreateDateColumn,
  YdbUpdateDateColumn,
  YdbBaseEntity,
  OneToMany,
  OneToOne,
} from '../../../src/index.js';
import { PostEntity } from './post.entity.js';
import { ProfileEntity } from './profile.entity.js';

@YdbEntity('users')
export class UserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbColumn('Utf8')
  email: string;

  @YdbColumn('Utf8')
  organization: string;

  /** Автопроставляется при INSERT (см. @YdbCreateDateColumn). */
  @YdbCreateDateColumn()
  @YdbColumn('Timestamp')
  created_at!: Date;

  /** Автопроставляется при INSERT и UPDATE. */
  @YdbUpdateDateColumn()
  @YdbColumn('Timestamp')
  updated_at!: Date;

  /** Все посты пользователя. join column — PostEntity.user_uuid. */
  @OneToMany(() => PostEntity, (post) => post.user_uuid)
  posts?: PostEntity[];

  /** Owning-сторона one-to-one: FK на профиль лежит в users.profile_uuid. */
  @OneToOne(() => ProfileEntity, (user) => user.profile_uuid)
  profile?: ProfileEntity;

  /** Внешний ключ профиля (owning-сторона one-to-one). */
  @YdbColumn('Uuid')
  profile_uuid: string;
}
