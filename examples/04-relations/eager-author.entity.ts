/**
 * Демонстрация @EagerLoad (локальная для примера 04-relations).
 *
 * @EagerLoad(['posts']) заставляет ORM подгружать посты ОДНИМ батч-запросом
 * `WHERE author_uuid IN (...)` при find/findAll авторов (без N+1).
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  OneToMany,
  EagerLoad,
} from '../../src/index.js';
import { EagerPostEntity } from './eager-post.entity.js';

@YdbEntity('eager_authors')
@EagerLoad(['posts'])
export class EagerAuthorEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name: string;

  @OneToMany(() => EagerPostEntity, (post) => post.author_uuid)
  posts?: EagerPostEntity[];
}
