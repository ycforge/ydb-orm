import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbEncrypted,
  YdbSecurityAAD,
  YdbBaseEntity,
  buildAad,
} from '../src/index.js';
import type { YdbEncryptionContext } from '../src/index.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import { createMockExecutor } from './helpers/mock-executor.js';

/**
 * Регрессионные тесты #166: updateBy() для зашифрованного поля принимает
 * только однозначные AAD-предикаты (прямое скалярное равенство или
 * { $eq: scalar }). $in, $between, диапазоны, $ne, логические группы,
 * массивы и null-формы отклоняются ДО запроса: иначе один ciphertext
 * записали бы в строки, контексты AAD которых различаются — при чтении
 * дешифровка вернула бы мусор.
 */

@YdbEntity('aad_unique_test')
class AadUniqueEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Utf8')
  declare tenant_id: string;

  @YdbSecurityAAD()
  @YdbPrimaryColumn('Utf8')
  declare org_id: string;

  @YdbEncrypted({ blindIndex: true })
  @YdbColumn('Utf8')
  secret?: string;

  @YdbEncrypted({ aadOverride: 'fixed-aad' })
  @YdbColumn('Utf8')
  pinned_secret?: string;
}

/** AAD-поля всех примитивных типов: один контракт сериализации (#166). */
@YdbEntity('aad_scalar_test')
class AadScalarEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Utf8')
  declare tenant_id: string;

  @YdbSecurityAAD()
  @YdbColumn('Timestamp')
  declare starts_at: Date;

  @YdbSecurityAAD()
  @YdbColumn('Int64')
  declare org_rank: bigint;

  @YdbSecurityAAD()
  @YdbColumn('Bool')
  declare active: boolean;

  @YdbEncrypted({ blindIndex: true })
  @YdbColumn('Utf8')
  secret?: string;
}

/** Провайдер, записывающий AAD/контекст encrypt для проверки. */
class RecordingEncryptionProvider extends TestOnlyEncryptionProvider {
  encrypts: { aad: string; context: YdbEncryptionContext }[] = [];

  override async encrypt(
    plaintext: string,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<Uint8Array> {
    this.encrypts.push({ aad, context });
    return super.encrypt(plaintext, aad, context);
  }
}

const FIXED_WHERE = { tenant_id: 't1', org_id: 'o1' };

describe('#166: updateBy() требует однозначный AAD-предикат', () => {
  afterEach(() => {
    AadUniqueEntity.setExecutor(undefined);
    AadUniqueEntity.setEncryptionProvider(undefined);
    AadUniqueEntity.setBlindIndexProvider(undefined);
    AadScalarEntity.setExecutor(undefined);
    AadScalarEntity.setEncryptionProvider(undefined);
    AadScalarEntity.setBlindIndexProvider(undefined);
  });

  it('прямое скалярное равенство по всем AAD-полям', async () => {
    const provider = new RecordingEncryptionProvider();
    AadUniqueEntity.setEncryptionProvider(provider);
    AadUniqueEntity.setBlindIndexProvider(provider);
    const mock = createMockExecutor([[]]);
    AadUniqueEntity.setExecutor(mock.executor);

    await AadUniqueEntity.updateBy(FIXED_WHERE, { secret: 's1' });

    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0].sql).toContain(
      'WHERE `tenant_id` = $tenant_id AND `org_id` = $org_id',
    );
    expect(provider.encrypts).toHaveLength(1);
    expect(provider.encrypts[0].context.aadFields).toEqual(FIXED_WHERE);
  });

  it('одиночный { $eq: scalar } для каждого AAD-поля', async () => {
    const provider = new RecordingEncryptionProvider();
    AadUniqueEntity.setEncryptionProvider(provider);
    AadUniqueEntity.setBlindIndexProvider(provider);
    const mock = createMockExecutor([[]]);
    AadUniqueEntity.setExecutor(mock.executor);

    await AadUniqueEntity.updateBy(
      { tenant_id: { $eq: 't1' }, org_id: { $eq: 'o1' } },
      { secret: 's1' },
    );

    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0].sql).toContain(
      'WHERE `tenant_id` = $tenant_id AND `org_id` = $org_id',
    );
    expect(provider.encrypts[0].context.aadFields).toEqual(FIXED_WHERE);
  });

  const ambiguousWhere: Array<[string, Record<string, any>]> = [
    ['$in', { tenant_id: { $in: ['t1', 't2'] }, org_id: 'o1' }],
    ['$between', { tenant_id: { $between: ['t1', 't2'] }, org_id: 'o1' }],
    ['$gt range', { tenant_id: { $gt: 't0' }, org_id: 'o1' }],
    ['$gte range', { tenant_id: { $gte: 't0' }, org_id: 'o1' }],
    ['$lt range', { tenant_id: { $lt: 't5' }, org_id: 'o1' }],
    ['$lte range', { tenant_id: { $lte: 't5' }, org_id: 'o1' }],
    ['$ne', { tenant_id: { $ne: 't2' }, org_id: 'o1' }],
    ['$like', { tenant_id: { $like: 't%' }, org_id: 'o1' }],
    ['$or logical group', { tenant_id: { $or: ['t1', 't2'] }, org_id: 'o1' }],
    ['multi-operator', { tenant_id: { $eq: 't1', $gt: 't0' }, org_id: 'o1' }],
    ['array value', { tenant_id: ['t1', 't2'], org_id: 'o1' }],
    ['$eq null', { tenant_id: { $eq: null }, org_id: 'o1' }],
  ];

  for (const [label, where] of ambiguousWhere) {
    it(`отклоняет неоднозначный предикат: ${label} — до любого запроса`, async () => {
      const provider = new RecordingEncryptionProvider();
      AadUniqueEntity.setEncryptionProvider(provider);
      AadUniqueEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      AadUniqueEntity.setExecutor(mock.executor);

      await expect(
        AadUniqueEntity.updateBy(where, { secret: 's1' }),
      ).rejects.toThrow(
        /cannot resolve a unique AAD predicate for field "tenant_id"/,
      );

      // Ошибка до encrypt и до обращения к БД.
      expect(provider.encrypts).toHaveLength(0);
      expect(mock.queries).toHaveLength(0);
    });
  }

  it('отсутствующее AAD-поле — прежняя ошибка "not fixed by the where predicate"', async () => {
    const provider = new RecordingEncryptionProvider();
    AadUniqueEntity.setEncryptionProvider(provider);
    AadUniqueEntity.setBlindIndexProvider(provider);
    const mock = createMockExecutor([[]]);
    AadUniqueEntity.setExecutor(mock.executor);

    await expect(
      AadUniqueEntity.updateBy({ tenant_id: 't1' }, { secret: 's1' }),
    ).rejects.toThrow(
      /AAD field\(s\) "org_id" are not fixed by the where predicate/,
    );
    expect(provider.encrypts).toHaveLength(0);
    expect(mock.queries).toHaveLength(0);
  });

  it('aadOverride по-прежнему обходит проверку уникальности — где остаётся произвольным', async () => {
    const provider = new RecordingEncryptionProvider();
    AadUniqueEntity.setEncryptionProvider(provider);
    AadUniqueEntity.setBlindIndexProvider(provider);
    const mock = createMockExecutor([[]]);
    AadUniqueEntity.setExecutor(mock.executor);

    await AadUniqueEntity.updateBy(
      { tenant_id: { $in: ['t1', 't2'] }, org_id: 'o1' },
      { pinned_secret: 's1' },
    );

    expect(mock.queries).toHaveLength(1);
    expect(provider.encrypts).toHaveLength(1);
    expect(provider.encrypts[0].aad).toBe('fixed-aad');
  });

  const makeScalarWhere = (when: Date) => ({
    tenant_id: 't1',
    starts_at: when,
    org_rank: 7n,
    active: true,
  });

  /**
   * Ожидаемый AAD по единому контракту (#166, v2 по умолчанию): aadFields
   * отсортированы алфавитно (entity-metadata), значения — каноническое
   * toAadString (Date → ISO, bigint/Bool → String), сборка — buildAad.
   * Тот же порядок и на encrypt-пути, и в updateBy.
   */
  const SCALAR_AAD_FIELDS = ['active', 'org_rank', 'starts_at', 'tenant_id'];
  const scalarAad = (when: Date): string => {
    const values = makeScalarWhere(when) as Record<string, unknown>;
    return buildAad(SCALAR_AAD_FIELDS, (name) => values[name]);
  };

  it('#166 единый контракт: updateBy() шифрует AAD-поля типов Date/Int64/Bool той же строкой', async () => {
    const provider = new RecordingEncryptionProvider();
    AadScalarEntity.setEncryptionProvider(provider);
    AadScalarEntity.setBlindIndexProvider(provider);
    const mock = createMockExecutor([[]]);
    AadScalarEntity.setExecutor(mock.executor);
    const when = new Date('2026-08-28T12:00:00.000Z');

    await AadScalarEntity.updateBy(makeScalarWhere(when), { secret: 'x' });

    expect(mock.queries).toHaveLength(1);
    expect(provider.encrypts[0].aad).toBe(scalarAad(when));
  });

  it('#166 updateBy() и обычный encrypt-путь дают одинаковый AAD для тех же значений', async () => {
    const when = new Date('2026-08-28T12:00:00.000Z');

    const viaUpdate = new RecordingEncryptionProvider();
    AadScalarEntity.setEncryptionProvider(viaUpdate);
    AadScalarEntity.setBlindIndexProvider(viaUpdate);
    AadScalarEntity.setExecutor(createMockExecutor([[]]).executor);
    await AadScalarEntity.updateBy(makeScalarWhere(when), { secret: 'x' });

    const viaSave = new RecordingEncryptionProvider();
    AadScalarEntity.setEncryptionProvider(viaSave);
    AadScalarEntity.setBlindIndexProvider(viaSave);
    AadScalarEntity.setExecutor(createMockExecutor([[]]).executor);

    const entity = new AadScalarEntity();
    entity.tenant_id = 't1';
    entity.starts_at = when;
    entity.org_rank = 7n;
    entity.active = true;
    entity.secret = 'x';
    // Мок не знает о существовании записи: UPDATE вернёт пусто и save()
    // упадёт после шифрования — AAD для пути encrypt уже записан.
    await AadScalarEntity.save(entity).catch(() => undefined);

    expect(viaUpdate.encrypts[0].aad).toBe(scalarAad(when));
    expect(viaSave.encrypts[0].aad).toBe(scalarAad(when));
    expect(viaUpdate.encrypts[0].aad).toBe(viaSave.encrypts[0].aad);
  });
});
