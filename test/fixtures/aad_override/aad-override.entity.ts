// aad_override/aad-override.entity.ts
import {
  YdbEntity,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEncrypted,
  YdbSecurityAAD,
} from '../../../src/index.js';

/**
 * Тестовая сущность для проекций с aadOverride (#240): secret использует
 * фиксированный AAD ('pin'), поэтому его проекция не обязана включать
 * AAD-колонку uuid.
 */
@YdbEntity('aad_override_secrets')
export class AadOverrideEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbEncrypted({ aadOverride: 'pin', blindIndex: false })
  secret: string;
}
