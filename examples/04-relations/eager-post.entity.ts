/**
 * Пост автора (для демонстрации @EagerLoad в примере 04-relations).
 * join column автора — `author_uuid`.
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  ManyToOne,
} from '../../src/index.js';
import { EagerAuthorEntity } from './eager-author.entity.js';

@YdbEntity('eager_posts')
export class EagerPostEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  title: string;

  /** Внешний ключ автора (join column). */
  @YdbColumn('Uuid')
  author_uuid: string;

  @ManyToOne(() => EagerAuthorEntity, (post) => post.author_uuid)
  author?: EagerAuthorEntity;
}
