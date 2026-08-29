/**
 * Пост — many-to-one к пользователю и many-to-many с тегами.
 *
 * join column для связи "пользователь -> посты" — колонка user_uuid
 * (FK на стороне PostEntity). Связь с тегами — через join-таблицу
 * `post_tags` (см. @JoinTable ниже).
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbCreateDateColumn,
  YdbBaseEntity,
  ManyToOne,
  ManyToMany,
  JoinTable,
} from '../../../src/index.js';
import { UserEntity } from './user.entity.js';
import { TagEntity } from './tag.entity.js';

@YdbEntity('posts')
export class PostEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  title: string;

  @YdbColumn('Utf8')
  content: string;

  @YdbColumn('Int32')
  views!: number;

  @YdbCreateDateColumn()
  @YdbColumn('Timestamp')
  created_at!: Date;

  /** Внешний ключ автора (join column): по нему ORM находит пользователя. */
  @YdbColumn('Uuid')
  user_uuid: string;

  /** Автор поста (many-to-one). */
  @ManyToOne(() => UserEntity, (post) => post.user_uuid)
  user?: UserEntity;

  /** Теги поста (many-to-many, join-таблица post_tags). */
  @ManyToMany(() => TagEntity, (tag) => tag.posts)
  @JoinTable('post_tags')
  tags?: TagEntity[];
}
