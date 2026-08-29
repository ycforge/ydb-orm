/**
 * Пользователь с конфиденциальными полями — основа примера 06-encryption.
 *
 *  - email — шифруется с blind index ({blindIndex: true} по умолчанию).
 *    В БД хранится ciphertext + synthetic-колонка `email_bi`
 *    (детерминированный хэш значения): по email можно искать через
 *    переданный в find/findAll критерий — ORM захеширует значение сам.
 *  - government_id — шифруется БЕЗ blind index: хранится только ciphertext,
 *    поиск по нему невозможен (ORM бросит ошибку).
 *  - uuid — первичный ключ, участвует в AAD (Additional Authenticated
 *    Data). @YdbSecurityAAD разрешён только на PK-колонках: ciphertext
 *    привязан к значению PK, изменение PK сделает расшифровку невозможной.
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbEncrypted,
  YdbSecurityAAD,
  YdbBaseEntity,
} from '../../../src/index.js';

@YdbEntity('secure_users')
export class EncryptedUserEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbEncrypted({ blindIndex: true })
  email: string;

  @YdbEncrypted({ blindIndex: false })
  government_id: string;

  /** Ленивое шифрование: поле дешифруется только явным вызовом. */
  @YdbEncrypted({ lazy: true })
  secret_note: string;
}
