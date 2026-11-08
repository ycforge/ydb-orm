import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEnum,
  YdbJson,
} from '../../../src/index.js';

/**
 * Regression #238: columns whose names match the generated parameter pattern
 * (`name_0_eq`) and the opaque name prefix (`w0`) must not cause the same
 * query parameter to be reused.
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
 * @YdbEnum (Utf8) named after the first WHERE parameter `w0`: the old bindParams
 * derived the enum conversion from the parameter key and replaced the predicate value.
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
 * @YdbEnum (Int32) named `w0`: without the fix the predicate value was silently
 * converted to Int32(0) and the parameter type was taken from the enum column.
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

/** @YdbJson named `w0`: replaced the WHERE parameter with JSON serialization. */
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

/** @YdbJson named `s0`: replaced the SET parameter with JSON serialization. */
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

/** @YdbEnum (Utf8) named `s0`: replaced the SET parameter with enum conversion. */
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
