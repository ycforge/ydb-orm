import 'reflect-metadata';
import { YdbEntity } from '../decorators/entity.decorator.js';
import { YdbColumn, YdbPrimaryColumn } from '../decorators/column.decorator.js';
import { YdbEncrypted } from '../decorators/encryption.decorator.js';
import {
  ManyToMany,
  JoinTable,
  OneToMany,
  OneToOne,
} from '../decorators/relation.decorators.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import {
  validateEntityMetadata,
  EntityValidationContext,
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

@YdbEntity('v_enc_pk')
class EncryptedPk extends YdbBaseEntity {
  @YdbEncrypted()
  @YdbPrimaryColumn('Uuid')
  uuid: string;
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
    expect(validateEntityMetadata(NotAnEntity, ctx)).toEqual([
      expect.stringContaining('not decorated with @YdbEntity'),
    ]);
  });

  it('rejects entity whose fallback uuid PK column is missing', () => {
    const issues = validateEntityMetadata(MissingPkColumn, ctx);
    expect(issues).toEqual([
      expect.stringContaining('primary key column "uuid" is not declared'),
    ]);
  });

  it('rejects encrypted primary key', () => {
    const issues = validateEntityMetadata(EncryptedPk, ctx);
    expect(issues).toEqual([
      expect.stringContaining('primary key "uuid" cannot be encrypted'),
    ]);
  });

  it('rejects encrypted field without @YdbColumn', () => {
    const issues = validateEntityMetadata(EncryptedNoColumn, ctx);
    expect(issues).toEqual([
      expect.stringContaining('encrypted field "secret" has no @YdbColumn'),
    ]);
  });

  it('rejects encrypted entity without configured providers', () => {
    const issues = validateEntityMetadata(ValidUser, noProviders);
    expect(issues).toEqual([
      expect.stringContaining('no encryptionProvider is configured'),
      expect.stringContaining('no blindIndexProvider is configured'),
    ]);
  });

  it('rejects relation to class without @YdbEntity', () => {
    const issues = validateEntityMetadata(BadRelTarget, ctx);
    expect(issues).toEqual([
      expect.stringContaining('not decorated with @YdbEntity'),
    ]);
  });

  it('rejects one-to-many with unknown join column on target', () => {
    const issues = validateEntityMetadata(BadJoinColumn, ctx);
    expect(issues).toEqual([
      expect.stringContaining('join column "no_such_column" is not a column'),
    ]);
  });

  it('rejects @JoinTable without @ManyToMany', () => {
    const issues = validateEntityMetadata(JoinTableWithoutManyToMany, ctx);
    expect(issues).toEqual([
      expect.stringContaining(
        '@JoinTable("v_orphan_jt") on "tags" without @ManyToMany',
      ),
    ]);
  });

  it('rejects many-to-many without @JoinTable on any side', () => {
    const issues = validateEntityMetadata(M2mNoJoinTableA, ctx);
    expect(issues).toEqual([
      expect.stringContaining('requires @JoinTable on one of the sides'),
    ]);
  });

  it('rejects many-to-many with @JoinTable on both sides', () => {
    const issues = validateEntityMetadata(M2mTwoJoinTablesA, ctx);
    expect(issues).toEqual([
      expect.stringContaining('both sides have @JoinTable'),
    ]);
  });
});
