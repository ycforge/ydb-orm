// photo_with_tags/photo_with_tags.entity.ts
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  ManyToMany,
  JoinTable,
  EagerLoad,
} from '../../../src/index.js';
import { TagEntity } from '../tag/tag.entity.js';

@YdbEntity('photos_with_tags')
@EagerLoad(['tags'])
export class PhotoWithTagsEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => TagEntity, (tag) => tag.photos)
  @JoinTable('photo_tag')
  tags?: TagEntity[];

  static async findByUuid(uuid: string) {
    return this.find({ uuid });
  }
}
