import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
} from '../../../src/index.js';

/** Фикстура #109: обратная сторона OneToOne (см. device.entity.ts). */

@YdbEntity('fixture_device_licenses')
export class DeviceLicenseEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  key: string;
}
