import 'reflect-metadata';
import { getOrCreateRepository } from '../src/index.js';
import { createScriptedExecutor } from './helpers/ydb-mock.js';
import { DeviceEntity } from './fixtures/one_to_one/device.entity.js';
import { DeviceLicenseEntity } from './fixtures/one_to_one/device-license.entity.js';

/**
 * Фикстурный спек OneToOne через loadRelations() (#109): связь из
 * fixtures/one_to_one загружается батч-лоадером (#86) — один IN-запрос
 * по PK целевой сущности, FK без совпадения → null.
 */

function deviceRepo() {
  return getOrCreateRepository(DeviceEntity);
}

function makeDevice(uuid: string, licenseUuid: string): DeviceEntity {
  const device = new DeviceEntity();
  device.uuid = uuid;
  device.model = 'model-x';
  device.license_uuid = licenseUuid;
  return device;
}

describe('#109: OneToOne через loadRelations (фикстуры one_to_one)', () => {
  it('загружает связанные лицензии одним IN-запросом по PK целевой сущности', async () => {
    const db = createScriptedExecutor({ label: 'devices-db' });
    DeviceEntity.setExecutor(db.executor);
    DeviceLicenseEntity.setExecutor(db.executor);

    db.expect(/FROM `fixture_device_licenses`/).returnsRows(
      { uuid: 'lic-1', key: 'KEY-1' },
      { uuid: 'lic-2', key: 'KEY-2' },
    );

    const devices = [
      makeDevice('d1', 'lic-1'),
      makeDevice('d2', 'missing'),
      makeDevice('d3', 'lic-2'),
      makeDevice('d4', 'lic-1'), // дубликат FK
    ];

    await deviceRepo().relations.loadRelations(devices, ['license']);

    // Один батч-запрос, а не по запросу на инстанс
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('WHERE `uuid` IN');
    // FK дедуплицируются: lic-1 (x2) + missing + lic-2 → 3 параметра
    expect(Object.keys(db.calls[0].params)).toHaveLength(3);

    expect(devices[0].license?.key).toBe('KEY-1');
    expect(devices[1].license).toBeNull();
    expect(devices[2].license?.key).toBe('KEY-2');
    // Инстансы с одинаковым FK разделяют связанную сущность
    expect(devices[3].license).toBe(devices[0].license);

    db.assertComplete();

    DeviceEntity.setExecutor(undefined as never);
    DeviceLicenseEntity.setExecutor(undefined as never);
  });

  it('пустой список инстансов → ноль запросов; FK без совпадения в БД → null', async () => {
    const db = createScriptedExecutor();
    DeviceEntity.setExecutor(db.executor);
    DeviceLicenseEntity.setExecutor(db.executor);

    await deviceRepo().relations.loadRelations([], ['license']);
    expect(db.calls).toHaveLength(0);

    // FK есть, но лицензии нет в результате — связь null, запрос один
    db.expect(/FROM `fixture_device_licenses`/).returns([]);
    const noMatch = makeDevice('d5', 'nope');
    await deviceRepo().relations.loadRelations([noMatch], ['license']);

    expect(db.calls).toHaveLength(1);
    expect(noMatch.license).toBeNull();

    DeviceEntity.setExecutor(undefined as never);
    DeviceLicenseEntity.setExecutor(undefined as never);
  });
});
