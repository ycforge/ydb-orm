// lazy_secret/lazy-secret.entity.ts
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEncrypted,
  YdbSecurityAAD,
} from '../../../src/index.js';

/**
 * Тестовая сущность для lazy decrypt (issue #18):
 * - secret_lazy — lazy-поле: не дешифруется при чтении из БД;
 * - secret_eager — обычное encrypted-поле: дешифруется сразу;
 * - tenant_id — AAD-поле для дешифровки.
 */
@YdbEntity('lazy_secrets')
export class LazySecretEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbSecurityAAD()
  @YdbColumn('Utf8')
  tenant_id: string;

  @YdbEncrypted({ lazy: true, blindIndex: true })
  @YdbColumn('Utf8')
  secret_lazy: string;

  @YdbEncrypted({ blindIndex: false })
  @YdbColumn('Utf8')
  secret_eager: string;
}
