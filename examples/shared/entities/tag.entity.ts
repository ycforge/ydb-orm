/**
 * Тег — inverse-сторона many-to-many «пост -> теги» (join-таблица
 * `post_tags` объявлена на стороне PostEntity через @JoinTable).
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  ManyToMany,
} from '../../../src/index.js';
import { PostEntity } from './post.entity.js';

@YdbEntity('tags')
export class TagEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name: string;

  /** Обратная ссылка: посты с этим тегом. */
  @ManyToMany(() => PostEntity, (post) => post.tags)
  posts?: PostEntity[];
}
