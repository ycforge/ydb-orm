/**
 * Пост пользователя (many-to-one: у поста один автор).
 * joinColumn — поле на стороне PostEntity, хранящее uuid автора.
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  ManyToOne,
} from '../../src/index.js';
import { UserEntity } from './user.entity.js';

@YdbEntity('posts')
export class PostEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  title: string;

  @YdbColumn('Utf8')
  content: string;

  // join column — FK на текущей (owning) сущности: PostEntity.user_uuid.
  @ManyToOne(() => UserEntity, (post) => post.user_uuid)
  user?: UserEntity;

  // Внешний ключ: по нему ORM находит автора. Не обязано быть PK.
  @YdbColumn('Uuid')
  user_uuid: string;
}
