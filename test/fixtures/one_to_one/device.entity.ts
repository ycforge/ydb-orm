import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  OneToOne,
} from '../../../src/index.js';
import { DeviceLicenseEntity } from './device-license.entity.js';

/**
 * Фикстура #109: OneToOne «владелец» — второй аргумент декоратора это
 * join-колонка НА ИСТОЧНИКЕ (license_uuid), значения которой сравниваются
 * с PK целевой сущности. Загружается через loadRelations (батч-лоадер #86).
 */

@YdbEntity('fixture_devices')
export class DeviceEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  model: string;

  @YdbColumn('Uuid')
  license_uuid: string;

  @OneToOne(() => DeviceLicenseEntity, 'license_uuid')
  license?: DeviceLicenseEntity;
}
