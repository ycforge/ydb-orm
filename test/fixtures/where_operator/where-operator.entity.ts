import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEncrypted,
} from '../../../src/index.js';

@YdbEntity('where_operator_test')
export class WhereOperatorEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  name!: string;

  @YdbColumn('Int64')
  balance!: bigint;

  @YdbColumn('Int32')
  rating!: number;

  @YdbColumn('Bool')
  is_admin!: boolean;

  @YdbColumn('Bool')
  is_banned!: boolean;

  @YdbColumn('Utf8')
  status!: string;

  @YdbEncrypted({ blindIndex: true })
  @YdbColumn('Utf8')
  secret!: string;

  @YdbEncrypted({ blindIndex: false })
  @YdbColumn('Utf8')
  unsearchable!: string;
}
