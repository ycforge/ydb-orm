import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEnum,
  YdbJson,
} from '../../../src/index.js';

/**
 * Регрессия #238: колонки, имена которых совпадают с шаблоном генерируемых
 * параметров (`name_0_eq`) и с префиксом опаковых имён (`w0`), не должны
 * приводить к переиспользованию одного query-параметра.
 */
@YdbEntity('param_collision_test')
export class ParamCollisionEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  name!: string;

  @YdbColumn('Utf8')
  name_0_eq!: string;

  @YdbColumn('Utf8')
  w0!: string;

  @YdbColumn('Utf8')
  w1!: string;
}

export enum CollisionStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

/**
 * @YdbEnum (Utf8) с именем первого WHERE-параметра `w0`: старый bindParams
 * выводил enum-конверсию из ключа параметра и подменял значение предиката.
 */
@YdbEntity('param_collision_enum_utf8_test')
export class ParamCollisionEnumUtf8Entity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  title!: string;

  @YdbEnum({ values: Object.values(CollisionStatus), storage: 'Utf8' })
  @YdbColumn('Utf8')
  w0!: CollisionStatus;
}

/**
 * @YdbEnum (Int32) с именем `w0`: без фикса значение предиката молча
 * конвертировалось в Int32(0) и тип параметра брался от enum-колонки.
 */
@YdbEntity('param_collision_enum_int32_test')
export class ParamCollisionEnumInt32Entity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  title!: string;

  @YdbEnum({ values: Object.values(CollisionStatus), storage: 'Int32' })
  @YdbColumn('Int32')
  w0!: CollisionStatus;
}

/** @YdbJson с именем `w0`: подменял WHERE-параметр JSON-сериализацией. */
@YdbEntity('param_collision_json_where_test')
export class ParamCollisionJsonWhereEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Int32')
  rating!: number;

  @YdbJson()
  @YdbColumn('Utf8')
  w0!: Record<string, any>;
}

/** @YdbJson с именем `s0`: подменял SET-параметр JSON-сериализацией. */
@YdbEntity('param_collision_json_set_test')
export class ParamCollisionJsonSetEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Int32')
  rating!: number;

  @YdbJson()
  @YdbColumn('Utf8')
  s0!: Record<string, any>;
}

/** @YdbEnum (Utf8) с именем `s0`: подменял SET-параметр enum-конверсией. */
@YdbEntity('param_collision_enum_set_test')
export class ParamCollisionEnumSetEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  title!: string;

  @YdbEnum({ values: Object.values(CollisionStatus), storage: 'Utf8' })
  @YdbColumn('Utf8')
  s0!: CollisionStatus;
}
