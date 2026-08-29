/**
 * Профиль пользователя (односторонний one-to-one).
 *
 * FK на профиль живёт в UserEntity.profile_uuid, поэтому сам one-to-one
 * декларируется на владельце (owning-сторона, UserEntity.profile).
 * Обратная ссылка user -> профиль грузится через author.loadRelations
 * (см. пример 04-relations).
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
} from '../../../src/index.js';

@YdbEntity('profiles')
export class ProfileEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  bio: string;
}
