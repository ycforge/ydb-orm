// aad_override/aad-override.entity.ts
import {
  YdbEntity,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEncrypted,
  YdbSecurityAAD,
} from '../../../src/index.js';

/**
 * Test entity for projections with aadOverride (#240): secret uses a
 * fixed AAD ('pin'), so its projection does not have to include the
 * AAD column uuid.
 */
@YdbEntity('aad_override_secrets')
export class AadOverrideEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbEncrypted({ aadOverride: 'pin', blindIndex: false })
  secret: string;
}
