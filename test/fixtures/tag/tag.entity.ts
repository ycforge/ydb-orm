// tag/tag.entity.ts
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  ManyToMany,
} from '../../../src/index.js';
import { PhotoWithTagsEntity } from '../photo_with_tags/photo_with_tags.entity.js';

@YdbEntity('tags')
export class TagEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => PhotoWithTagsEntity, (photo) => photo.tags)
  photos?: PhotoWithTagsEntity[];
}
