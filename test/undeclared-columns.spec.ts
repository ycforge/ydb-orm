import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEncrypted,
  YdbEnum,
  OneToMany,
  ManyToOne,
  getOrCreateRepository,
} from '../src/index.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import {
  createMockExecutor,
  type MockExecutor,
} from './helpers/mock-executor.js';

/**
 * Регрессионные тесты #164: колонки, отсутствующие в метаданных, не должны
 * попадать на гидратированные инстансы и в JSON.stringify().
 *
 * Раньше SELECT * + копирование всех колонок строки означали, что legacy
 * секретная колонка, выпиленная из entity (recovery_token и т.п.), всё ещё
 * читается и утекает в JSON() — сериализуются ВСЕ enumerable-свойства.
 */

@YdbEntity('udc_users')
class UndeclaredUserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbEncrypted({ blindIndex: true })
  email: string | null;

  @YdbEncrypted({ lazy: true, blindIndex: true })
  note: string | null;

  @YdbColumn('Int32')
  @YdbEnum({ values: ['active', 'banned'], storage: 'Int32' })
  status?: string | undefined;

  @YdbColumn('Json')
  profile?: Record<string, unknown> | undefined;

  @OneToMany(() => UndeclaredLogEntity, 'user_uuid')
  logs?: any[];
}

@YdbEntity('udc_logs')
class UndeclaredLogEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  text: string;

  @YdbColumn('Utf8')
  user_uuid: string;

  @ManyToOne(() => UndeclaredUserEntity, 'user_uuid')
  user?: any;
}

const UUID = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: UUID,
    name: 'Alice',
    email: new TextEncoder().encode('a@b.c'),
    note: null,
    status: 0,
    profile: '{"city":"Msk"}',
    // Необъявленная колонка — legacy-секрет из БД.
    legacy_secret: 'top-secret',
    ...over,
  };
}

function configure(provider: TestOnlyEncryptionProvider, mock: MockExecutor) {
  UndeclaredUserEntity.setExecutor(mock.executor);
  UndeclaredUserEntity.setEncryptionProvider(provider);
  UndeclaredUserEntity.setBlindIndexProvider(provider);
  UndeclaredLogEntity.setExecutor(mock.executor);
  UndeclaredLogEntity.setEncryptionProvider(provider);
  UndeclaredLogEntity.setBlindIndexProvider(provider);
}

const PROJECTION =
  'SELECT `uuid`, `name`, `status`, `profile`, `email`, `note`';

describe('#164: необъявленные колонки исключаются из инстансов и JSON', () => {
  afterEach(() => {
    UndeclaredUserEntity.setExecutor(undefined);
    UndeclaredUserEntity.setEncryptionProvider(undefined);
    UndeclaredUserEntity.setBlindIndexProvider(undefined);
    UndeclaredLogEntity.setExecutor(undefined);
    UndeclaredLogEntity.setEncryptionProvider(undefined);
    UndeclaredLogEntity.setBlindIndexProvider(undefined);
  });

  it('findAll: лишние колонки НЕ на инстансе и НЕ в JSON; объявленные декодируются', async () => {
    const provider = new TestOnlyEncryptionProvider();
    const mock = createMockExecutor([[makeRow()]]);
    configure(provider, mock);

    const users = await UndeclaredUserEntity.findAll({});

    // Дефолтная проекция — только объявленные колонки (#164).
    expect(mock.queries[0].sql).toContain(`${PROJECTION} FROM `);
    expect(mock.queries[0].sql).not.toContain('SELECT *');

    const user = users[0];
    expect((user as any).legacy_secret).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(user, 'legacy_secret')).toBe(
      false,
    );

    // Объявленные колонки декодируются как раньше: шифрование, enum, JSON.
    expect(user.name).toBe('Alice');
    expect(user.email).toBe('a@b.c');
    expect(user.status).toBe('active');
    expect(user.profile).toEqual({ city: 'Msk' });

    const json = JSON.stringify(user);
    expect(json).not.toContain('top-secret');
    expect(json).not.toContain('legacy_secret');
  });

  it('find(): лишняя колонка не попадает в инстанс и JSON', async () => {
    const provider = new TestOnlyEncryptionProvider();
    const mock = createMockExecutor([[makeRow()]]);
    configure(provider, mock);

    const user = await UndeclaredUserEntity.find({ uuid: UUID });

    expect(user).not.toBeNull();
    expect((user as any).legacy_secret).toBeUndefined();
    expect(JSON.stringify(user)).not.toContain('top-secret');
  });

  it('explicit select по-прежнему выбирает только указанные колонки', async () => {
    const provider = new TestOnlyEncryptionProvider();
    // Строка как вернул бы YDB при SELECT uuid, name: только эти колонки.
    const mock = createMockExecutor([
      [{ uuid: UUID, name: 'Alice', legacy_secret: 'top-secret' }],
    ]);
    configure(provider, mock);

    const user = await UndeclaredUserEntity.find(
      { uuid: UUID },
      { select: ['uuid', 'name'] },
    );

    expect(mock.queries[0].sql).toContain('SELECT `uuid`, `name` FROM ');
    expect(mock.queries[0].sql).not.toContain('SELECT *');
    expect(user!.name).toBe('Alice');
    expect((user as any).email).toBeUndefined();
    expect((user as any).legacy_secret).toBeUndefined();
  });

  it('lazy-поле дешифруется как раньше, лишняя колонка не утекает', async () => {
    const provider = new TestOnlyEncryptionProvider();
    const mock = createMockExecutor([
      [makeRow({ note: new TextEncoder().encode('secret-note') })],
    ]);
    configure(provider, mock);

    const [user] = await UndeclaredUserEntity.findAll({});

    // Lazy-поле хранит ciphertext до явной дешифровки.
    expect(user.note).toEqual(new TextEncoder().encode('secret-note'));
    await user.decryptLazyFields();
    expect(user.note).toBe('secret-note');

    // После дешифровки JSON включает note, но не legacy-секрет.
    const json = JSON.stringify(user);
    expect(json).toContain('secret-note');
    expect(json).not.toContain('top-secret');
    expect(json).not.toContain('legacy_secret');
  });

  it('relations: лишние колонки связанных строк тоже исключаются', async () => {
    const provider = new TestOnlyEncryptionProvider();
    const mock = createMockExecutor([
      [
        {
          uuid: '00000000-0000-0000-0000-0000000000a1',
          text: 'log-1',
          user_uuid: UUID,
          // Необъявленная колонка в связанной сущности.
          legacy_token: 'leak',
        },
      ],
    ]);
    configure(provider, mock);

    const user = Object.assign(new UndeclaredUserEntity(), {
      uuid: UUID,
      name: 'Alice',
    });
    await getOrCreateRepository(UndeclaredUserEntity).relations.loadRelations(
      [user],
      ['logs'],
    );

    expect(user.logs).toHaveLength(1);
    const log = user.logs![0];
    expect(log.legacy_token).toBeUndefined();
    expect(log.text).toBe('log-1');
    expect(JSON.stringify(log)).not.toContain('leak');
  });
});
