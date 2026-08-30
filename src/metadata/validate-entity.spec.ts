import 'reflect-metadata';
import { YdbEntity } from '../decorators/entity.decorator.js';
import { YdbColumn, YdbPrimaryColumn } from '../decorators/column.decorator.js';
import {
  YdbEncrypted,
  YdbSecurityAAD,
} from '../decorators/encryption.decorator.js';
import {
  ManyToMany,
  JoinTable,
  OneToMany,
  OneToOne,
} from '../decorators/relation.decorators.js';
import { YdbIndex } from '../decorators/index.decorator.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import {
  validateEntityMetadata,
  validationIssuesToMessages,
  EntityValidationContext,
  EntityValidationIssue,
} from './validate-entity.js';

const ctx: EntityValidationContext = {
  encryptionProviderConfigured: true,
  blindIndexProviderConfigured: true,
};

const noProviders: EntityValidationContext = {
  encryptionProviderConfigured: false,
  blindIndexProviderConfigured: false,
};

@YdbEntity('v_users')
class ValidUser extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbEncrypted({ blindIndex: true })
  @YdbColumn('Utf8')
  email: string;
}

@YdbEntity('v_roles')
class ValidRole extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Uuid')
  user_uuid: string;
}

@YdbEntity('v_with_rel')
class ValidWithRelations extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Uuid')
  user_uuid: string;

  @OneToMany(() => ValidRole, 'user_uuid')
  roles?: ValidRole[];

  @OneToOne(() => ValidUser, 'user_uuid')
  user?: ValidUser;
}

class NotAnEntity extends YdbBaseEntity {}

@YdbEntity('v_missing_pk_col')
class MissingPkColumn extends YdbBaseEntity {
  @YdbColumn('Utf8')
  name: string;
}

@YdbEntity('v_aad_on_non_pk')
class AadOnNonPk extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbSecurityAAD()
  @YdbColumn('Utf8')
  tenant_id: string;
}

@YdbEntity('v_enc_pk')
class EncryptedPk extends YdbBaseEntity {
  @YdbEncrypted()
  @YdbPrimaryColumn('Uuid')
  uuid: string;
}

/** AAD-поле Json: объектное значение не имеет детерминированного AAD (#165). */
@YdbEntity('v_aad_json')
class AadJsonPk extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Json')
  attributes: unknown;
}

/** AAD-поле Bytes: допустимый скаляр (base64-нормализация в AAD, #165). */
@YdbEntity('v_aad_bytes')
class AadBytesPk extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Bytes')
  fingerprint: Uint8Array;
}

@YdbEntity('v_enc')
class EncryptedNoColumn extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbEncrypted()
  secret: string;
}

@YdbEntity('v_bad_rel_target')
class BadRelTarget extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @OneToMany(() => NotAnEntity, 'owner_uuid')
  items?: NotAnEntity[];
}

@YdbEntity('v_bad_join_col')
class BadJoinColumn extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @OneToMany(() => ValidRole, 'no_such_column')
  roles?: ValidRole[];
}

@YdbEntity('v_jt_no_m2m')
class JoinTableWithoutManyToMany extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @JoinTable('v_orphan_jt')
  tags?: unknown[];
}

@YdbEntity('v_m2m_no_jt_a')
class M2mNoJoinTableA extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @ManyToMany(() => M2mNoJoinTableB)
  bs?: M2mNoJoinTableB[];
}

@YdbEntity('v_m2m_no_jt_b')
class M2mNoJoinTableB extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @ManyToMany(() => M2mNoJoinTableA)
  as?: M2mNoJoinTableA[];
}

@YdbEntity('v_bad_idx')
@YdbIndex({ columns: ['nope'] })
class BadIndexColumn extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;
}

@YdbEntity('v_m2m_two_jt_a')
class M2mTwoJoinTablesA extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @ManyToMany(() => M2mTwoJoinTablesB)
  @JoinTable('v_jt_a')
  bs?: M2mTwoJoinTablesB[];
}

@YdbEntity('v_m2m_two_jt_b')
class M2mTwoJoinTablesB extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @ManyToMany(() => M2mTwoJoinTablesA)
  @JoinTable('v_jt_b')
  as?: M2mTwoJoinTablesA[];
}

describe('validateEntityMetadata', () => {
  it('accepts a valid entity', () => {
    expect(validateEntityMetadata(ValidUser, ctx)).toEqual([]);
  });

  it('accepts valid relations', () => {
    expect(validateEntityMetadata(ValidWithRelations, ctx)).toEqual([]);
  });

  it('rejects class without @YdbEntity', () => {
    const issues = validateEntityMetadata(NotAnEntity, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining('not decorated with @YdbEntity'),
    ]);
    expect(issues[0].code).toBe('MISSING_ENTITY_DECORATOR');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].path).toContain(NotAnEntity.name);
  });

  it('rejects entity without any primary key', () => {
    const issues = validateEntityMetadata(MissingPkColumn, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining('must declare at least one primary key'),
    ]);
    expect(issues[0].code).toBe('MISSING_PRIMARY_KEY');
  });

  it('rejects @YdbSecurityAAD on non-primary-key column', () => {
    const issues = validateEntityMetadata(AadOnNonPk, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining(
        '@YdbSecurityAAD field "tenant_id" must be a primary key column',
      ),
    ]);
    expect(issues[0].code).toBe('SECURITY_AAD_NOT_PRIMARY_KEY');
    expect(issues[0].path).toContain('.tenant_id');
  });

  it('rejects encrypted primary key', () => {
    const issues = validateEntityMetadata(EncryptedPk, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining('primary key "uuid" cannot be encrypted'),
    ]);
    expect(issues[0].code).toBe('ENCRYPTED_PRIMARY_KEY');
  });

  it('rejects @YdbSecurityAAD on Json column (not serializable to AAD)', () => {
    const issues = validateEntityMetadata(AadJsonPk, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining(
        '@YdbSecurityAAD field "attributes" has type Json, which cannot be serialized to AAD',
      ),
    ]);
    expect(issues[0].code).toBe('SECURITY_AAD_UNSAFE_TYPE');
  });

  it('accepts @YdbSecurityAAD on Bytes column (base64-normalized in AAD)', () => {
    const issues = validateEntityMetadata(AadBytesPk, ctx);
    expect(issues).toEqual([]);
  });

  it('accepts encrypted field without @YdbColumn (Bytes implied)', () => {
    const issues = validateEntityMetadata(EncryptedNoColumn, ctx);
    expect(issues).toEqual([]);
  });

  it('rejects encrypted entity without configured providers', () => {
    const issues = validateEntityMetadata(ValidUser, noProviders);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining('no encryptionProvider is configured'),
      expect.stringContaining('no blindIndexProvider is configured'),
    ]);
    expect(issues.map((i) => i.code)).toEqual([
      'ENCRYPTION_PROVIDER_MISSING',
      'BLIND_INDEX_PROVIDER_MISSING',
    ]);
  });

  it('rejects relation to class without @YdbEntity', () => {
    const issues = validateEntityMetadata(BadRelTarget, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining('not decorated with @YdbEntity'),
    ]);
    expect(issues[0].code).toBe('RELATION_TARGET_NOT_ENTITY');
  });

  it('rejects one-to-many with unknown join column on target', () => {
    const issues = validateEntityMetadata(BadJoinColumn, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining('join column "no_such_column" is not a column'),
    ]);
    expect(issues[0].code).toBe('RELATION_JOIN_COLUMN_NOT_ON_TARGET');
  });

  it('rejects @JoinTable without @ManyToMany', () => {
    const issues = validateEntityMetadata(JoinTableWithoutManyToMany, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining(
        '@JoinTable("v_orphan_jt") on "tags" without @ManyToMany',
      ),
    ]);
    expect(issues[0].code).toBe('JOIN_TABLE_WITHOUT_MANY_TO_MANY');
  });

  it('rejects many-to-many without @JoinTable on any side', () => {
    const issues = validateEntityMetadata(M2mNoJoinTableA, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining('requires @JoinTable on one of the sides'),
    ]);
    expect(issues[0].code).toBe('M2M_NO_JOIN_TABLE');
  });

  it('rejects @YdbIndex with unknown column', () => {
    const issues = validateEntityMetadata(BadIndexColumn, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining('@YdbIndex references unknown column "nope"'),
    ]);
    expect(issues[0].code).toBe('INDEX_UNKNOWN_COLUMN');
  });

  it('rejects many-to-many with @JoinTable on both sides', () => {
    const issues = validateEntityMetadata(M2mTwoJoinTablesA, ctx);
    expect(validationIssuesToMessages(issues)).toEqual([
      expect.stringContaining('both sides have @JoinTable'),
    ]);
    expect(issues[0].code).toBe('M2M_BOTH_JOIN_TABLES');
  });

  it('every issue carries a stable code, severity and the human message', () => {
    const issues: EntityValidationIssue[] = validateEntityMetadata(
      AadOnNonPk,
      ctx,
    );
    for (const issue of issues) {
      expect(typeof issue.code).toBe('string');
      expect(issue.code.length).toBeGreaterThan(0);
      expect(issue.severity).toBe('error');
      expect(typeof issue.message).toBe('string');
      expect(issue.message.length).toBeGreaterThan(0);
      expect(validationIssuesToMessages(issues)).toEqual(
        issues.map((i) => i.message),
      );
    }
  });
});
