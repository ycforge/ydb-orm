import 'reflect-metadata';
import { YdbEntity } from '../src/decorators/entity.decorator.js';
import {
  YdbPrimaryColumn,
  YdbColumn,
} from '../src/decorators/column.decorator.js';
import { YdbBaseEntity } from '../src/entity/base-entity.js';
import { YdbTtl, getYdbTtlMetadata } from '../src/decorators/ttl.decorator.js';
import {
  buildExpectedTableSchema,
  generateCreateTableYql,
} from '../src/schema/schema-sync.js';
import { getYdbEntityMetadata } from '../src/metadata/entity-metadata.js';

const meta = (entity: new (...args: any[]) => any) => {
  const m = getYdbEntityMetadata(entity);
  if (!m) throw new Error('no metadata');
  return m;
};

@YdbEntity('ttl_sessions')
@YdbTtl({ interval: 'PT2H' })
class TtlSessionEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  token: string;
}

@YdbEntity('ttl_custom_col')
@YdbTtl({ interval: 'P30D', column: 'expires_at' })
class TtlCustomColumnEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Timestamp')
  expires_at: string;
}

@YdbEntity('no_ttl_entity')
class NoTtlEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;
}

@YdbEntity('ttl_composite_pk')
@YdbTtl({ interval: 'PT1H' })
class TtlCompositePkEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant_id: string;

  @YdbPrimaryColumn('Int64')
  id: string;

  @YdbColumn('Utf8')
  data: string;
}

class TtlDuplicateEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;
}

describe('@YdbTtl', () => {
  it('stores TTL metadata on class', () => {
    const ttl = getYdbTtlMetadata(TtlSessionEntity);
    expect(ttl).toEqual({ interval: 'PT2H' });
  });

  it('stores TTL with custom column', () => {
    const ttl = getYdbTtlMetadata(TtlCustomColumnEntity);
    expect(ttl).toEqual({ interval: 'P30D', column: 'expires_at' });
  });

  it('returns undefined for entity without TTL', () => {
    const ttl = getYdbTtlMetadata(NoTtlEntity);
    expect(ttl).toBeUndefined();
  });

  it('throws when applied twice to the same class', () => {
    // Apply first @YdbTtl — should succeed
    YdbTtl({ interval: 'PT2H' })(TtlDuplicateEntity);
    expect(getYdbTtlMetadata(TtlDuplicateEntity)).toEqual({ interval: 'PT2H' });

    // Apply second @YdbTtl — should throw
    expect(() => {
      YdbTtl({ interval: 'P1D' })(TtlDuplicateEntity);
    }).toThrow(/can only be applied once/);
  });
});

describe('ExpectedTableSchema with TTL', () => {
  it('includes TTL in schema when decorator is present', () => {
    const schema = buildExpectedTableSchema(meta(TtlSessionEntity));
    expect(schema.ttl).toEqual({ interval: 'PT2H', column: 'uuid' });
  });

  it('uses custom column from TTL options', () => {
    const schema = buildExpectedTableSchema(meta(TtlCustomColumnEntity));
    expect(schema.ttl).toEqual({ interval: 'P30D', column: 'expires_at' });
  });

  it('defaults to first PK when column is not specified', () => {
    const schema = buildExpectedTableSchema(meta(TtlCompositePkEntity));
    expect(schema.ttl).toEqual({ interval: 'PT1H', column: 'tenant_id' });
  });

  it('has no TTL when decorator is absent', () => {
    const schema = buildExpectedTableSchema(meta(NoTtlEntity));
    expect(schema.ttl).toBeUndefined();
  });
});

describe('generateCreateTableYql with TTL', () => {
  it('includes TTL clause in CREATE TABLE DDL', () => {
    const schema = buildExpectedTableSchema(meta(TtlSessionEntity));
    const yql = generateCreateTableYql(schema);

    expect(yql).toContain('TTL = Interval("PT2H") ON `uuid`');
    // PK идёт перед TTL
    const pkIndex = yql.indexOf('PRIMARY KEY');
    const ttlIndex = yql.indexOf('TTL');
    expect(pkIndex).toBeLessThan(ttlIndex);
  });

  it('includes TTL with custom column', () => {
    const schema = buildExpectedTableSchema(meta(TtlCustomColumnEntity));
    const yql = generateCreateTableYql(schema);

    expect(yql).toContain('TTL = Interval("P30D") ON `expires_at`');
  });

  it('does not include TTL clause when decorator is absent', () => {
    const schema = buildExpectedTableSchema(meta(NoTtlEntity));
    const yql = generateCreateTableYql(schema);

    expect(yql).not.toContain('TTL');
  });

  it('generates valid full CREATE TABLE with TTL', () => {
    const schema = buildExpectedTableSchema(meta(TtlSessionEntity));
    const yql = generateCreateTableYql(schema);

    expect(yql).toBe(
      'CREATE TABLE `ttl_sessions` (\n' +
        '  `uuid` Uuid,\n' +
        '  `token` Utf8,\n' +
        '  PRIMARY KEY (`uuid`),\n' +
        '  TTL = Interval("PT2H") ON `uuid`\n' +
        ')',
    );
  });
});
