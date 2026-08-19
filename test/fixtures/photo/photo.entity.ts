// photo/photo.entity.ts
import {
  YdbEntity,
  YdbPrimaryColumn,
  YdbColumn,
  YdbEncrypted,
  YdbBaseEntity,
} from '../../../src/index.js';

/**
 * Тестовая сущность для проверки schema sync (sync: true):
 * покрывает все поддерживаемые примитивы YDB и synthetic
 * {field}_bi колонку blind index. Relations намеренно нет.
 */
@YdbEntity('photos')
export class PhotoEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  title: string;

  @YdbColumn('Utf8')
  description: string;

  @YdbColumn('Int32')
  width: number;

  @YdbColumn('Int32')
  height: number;

  @YdbColumn('Int64')
  file_size: bigint;

  @YdbColumn('Double')
  rating: number;

  @YdbColumn('Bool')
  is_public: boolean;

  @YdbEncrypted({ blindIndex: true })
  author_email: string;

  @YdbColumn('Int32')
  like_count: number;
}
