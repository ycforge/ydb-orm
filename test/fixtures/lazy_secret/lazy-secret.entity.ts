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
 * - uuid — PK и AAD-поле для дешифровки.
 * Шифруемые поля хранятся как Bytes — @YdbColumn для них не объявляется.
 */
@YdbEntity('lazy_secrets')
export class LazySecretEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  tenant_id: string;

  @YdbEncrypted({ lazy: true, blindIndex: true })
  secret_lazy: string;

  @YdbEncrypted({ blindIndex: false })
  secret_eager: string;
}
