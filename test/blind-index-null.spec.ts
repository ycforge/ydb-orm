import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEncrypted,
} from '../src/index.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import {
  createMockExecutor,
  type MockExecutor,
} from './helpers/mock-executor.js';
import { createScriptedExecutor } from './helpers/ydb-mock.js';

/**
 * Регрессионные тесты #175: очистка blind index при null.
 *
 * Раньше при установке зашифрованного поля в null ciphertext-колонка
 * писалась null, а synthetic {field}_bi НЕ писалась вовсе — старый хеш
 * оставался в строке, и поиск прежнего plaintext всё ещё находил запись.
 * Теперь явный null очищает обе колонки; undefined остаётся омиссией.
 */

@YdbEntity('bi_test')
class BiEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbColumn('Utf8')
  name?: string;

  @YdbEncrypted({ blindIndex: true })
  secret?: string | null;

  @YdbEncrypted({ lazy: true, blindIndex: true })
  token?: string | null;
}

const UUID = '00000000-0000-0000-0000-000000000001';
const HASH_OF = (plain: string) =>
  Buffer.from(`bi:${plain}`, 'utf8').toString('base64');

function configure(provider: TestOnlyEncryptionProvider, mock: MockExecutor) {
  BiEntity.setExecutor(mock.executor);
  BiEntity.setEncryptionProvider(provider);
  BiEntity.setBlindIndexProvider(provider);
}

describe('#175: blind index очищается при null', () => {
  afterEach(() => {
    BiEntity.setExecutor(undefined as any);
    BiEntity.setEncryptionProvider(undefined);
    BiEntity.setBlindIndexProvider(undefined);
  });

  describe('save() на существующей записи (update-путь)', () => {
    it('eager-поле в null: ciphertext и blind index пишутся null вместе', async () => {
      const provider = new TestOnlyEncryptionProvider();
      const mock = createMockExecutor([[{ uuid: UUID, secret: null }]]);
      configure(provider, mock);

      const e = new BiEntity();
      e.uuid = UUID;
      e.secret = null;
      await BiEntity.save(e);

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `bi_test`');
      expect(q.sql).toContain('`secret` = $secret');
      expect(q.sql).toContain('`secret_bi` = $secret_bi');
      expect((q.params.secret as any).item).toBeNull();
      expect((q.params.secret_bi as any).item).toBeNull();
    });

    it('lazy-поле в null: ciphertext и blind index пишутся null вместе', async () => {
      const provider = new TestOnlyEncryptionProvider();
      const mock = createMockExecutor([[{ uuid: UUID, token: null }]]);
      configure(provider, mock);

      const e = new BiEntity();
      e.uuid = UUID;
      e.token = null;
      await BiEntity.save(e);

      const [q] = mock.queries;
      expect(q.sql).toContain('`token` = $token');
      expect(q.sql).toContain('`token_bi` = $token_bi');
      expect((q.params.token as any).item).toBeNull();
      expect((q.params.token_bi as any).item).toBeNull();
    });

    it('нормальное значение: blind index по-прежнему пишется хешем', async () => {
      const provider = new TestOnlyEncryptionProvider();
      const mock = createMockExecutor([
        [{ uuid: UUID, secret: new TextEncoder().encode('hello') }],
      ]);
      configure(provider, mock);

      const e = new BiEntity();
      e.uuid = UUID;
      e.secret = 'hello';
      await BiEntity.save(e);

      const [q] = mock.queries;
      expect(q.sql).toContain('`secret_bi` = $secret_bi');
      expect(q.params.secret_bi).toBeDefined();
      expect(q.params.secret_bi).not.toBeNull();
    });

    it('undefined — омиссия: ни ciphertext, ни blind index не пишутся', async () => {
      const provider = new TestOnlyEncryptionProvider();
      const mock = createMockExecutor([[{ uuid: UUID, name: 'txt' }]]);
      configure(provider, mock);

      const e = new BiEntity();
      e.uuid = UUID;
      e.name = 'Ivan';
      // secret оставлен undefined — колонки не должны попасть в SQL.
      await BiEntity.save(e);

      const [q] = mock.queries;
      expect(q.sql).toContain('`name` = $name');
      expect(q.sql).not.toContain('`secret` =');
      expect(q.sql).not.toContain('`secret_bi` =');
    });
  });

  describe('updateBy()', () => {
    it('null для eager-поля: SET включает ciphertext и blind index = null', async () => {
      const provider = new TestOnlyEncryptionProvider();
      const mock = createMockExecutor([[]]);
      configure(provider, mock);

      await BiEntity.updateBy({ uuid: UUID }, { secret: null });

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `bi_test`');
      expect(q.sql).toContain('`secret` = $secret');
      expect(q.sql).toContain('`secret_bi` = $secret_bi');
      expect((q.params.secret as any).item).toBeNull();
      expect((q.params.secret_bi as any).item).toBeNull();
    });

    it('null для lazy-поля: SET включает ciphertext и blind index = null', async () => {
      const provider = new TestOnlyEncryptionProvider();
      const mock = createMockExecutor([[]]);
      configure(provider, mock);

      await BiEntity.updateBy({ uuid: UUID }, { token: null });

      const [q] = mock.queries;
      expect(q.sql).toContain('`token` = $token');
      expect(q.sql).toContain('`token_bi` = $token_bi');
      expect((q.params.token as any).item).toBeNull();
      expect((q.params.token_bi as any).item).toBeNull();
    });

    it('undefined — омиссия: поле исключается из patch, blind index не трогается', async () => {
      const provider = new TestOnlyEncryptionProvider();
      const mock = createMockExecutor([[{ uuid: UUID }]]);
      configure(provider, mock);

      await BiEntity.updateBy(
        { uuid: UUID },
        { name: 'Ivan', secret: undefined },
      );

      const [q] = mock.queries;
      expect(q.sql).toContain('`name` = $name');
      expect(q.sql).not.toContain('`secret` =');
      expect(q.sql).not.toContain('`secret_bi` =');
    });

    it('не-null значение: blind index пишется хешем нового plaintext', async () => {
      const provider = new TestOnlyEncryptionProvider();
      const mock = createMockExecutor([[]]);
      configure(provider, mock);

      await BiEntity.updateBy({ uuid: UUID }, { secret: 'new-secret' });

      const [q] = mock.queries;
      expect(q.sql).toContain('`secret_bi` = $secret_bi');
      expect(q.params.secret_bi).toBeDefined();
      expect((q.params.secret_bi as any).value).toBe(HASH_OF('new-secret'));
    });
  });

  describe('поиск прежнего plaintext после очистки', () => {
    it('find по зашифрованному полю идёт по blind index и не находит очищенную строку', async () => {
      const provider = new TestOnlyEncryptionProvider();
      const db = createScriptedExecutor();
      BiEntity.setExecutor(db.executor);
      BiEntity.setEncryptionProvider(provider);
      BiEntity.setBlindIndexProvider(provider);

      // 1. updateBy обнуляет поле — RETURNING по PK.
      db.expect(/UPDATE `bi_test`/).returns([[{ uuid: UUID }]]);
      await BiEntity.updateBy({ uuid: UUID }, { secret: null });

      // 2. Поиск прежнего plaintext: запрос по secret_bi, БД не отдаёт
      //    строку (blind index в ней null) → find() возвращает null.
      db.expect(
        /SELECT \* FROM `bi_test` WHERE `secret_bi` = \$secret_bi LIMIT 1/,
      ).returns([]);
      const hits = await BiEntity.find({ secret: 'old-secret' });
      expect(hits).toBeNull();

      const findCall = db.calls[db.calls.length - 1];
      expect(findCall.params.secret_bi).toBeDefined();
      expect((findCall.params.secret_bi as any).value).toBe(
        HASH_OF('old-secret'),
      );
      db.assertComplete();
    });
  });
});
