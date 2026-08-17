/**
 * Профиль пользователя (one-to-one). Не owning: FK на Profile живёт
 * в UserEntity.profile_uuid. Inverse-декоратор ниже носит описательный
 * характер — загрузка relation выполняется с owning-стороны (user.profile).
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  OneToOne,
} from '../../src/index.js';
import { UserEntity } from './user.entity.js';

@YdbEntity('profiles')
export class ProfileEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  // Inverse-описание (back-reference) — не используется для загрузки.
  @OneToOne(() => UserEntity, (user) => user.profile_uuid)
  user?: UserEntity;

  @YdbColumn('Utf8')
  bio: string;
}
