import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbCreateDateColumn,
  YdbUpdateDateColumn,
} from '../../../src/index.js';

@YdbEntity('timestamp_test')
export class TimestampEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbCreateDateColumn()
  @YdbColumn('Timestamp')
  created_at: Date;

  @YdbUpdateDateColumn()
  @YdbColumn('Timestamp')
  updated_at: Date;
}

@YdbEntity('timestamp_create_only')
export class CreateOnlyEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbCreateDateColumn()
  @YdbColumn('Timestamp')
  created_at: Date;
}
