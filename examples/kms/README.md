# KMS encryption example for ydb-orm

This document describes how to configure KMS-backed encryption for fields and how to use @YdbEncrypted/@YdbSecurityAAD in your entities.

Overview (русский)
- ydb-orm поддерживает шифрование полей через EncryptionProvider.
- В продакшене вы обычно используете KMS (AWS KMS, GCP KMS, Azure Key Vault) — провайдер управляет мастер-ключами и операции шифрования/дешифрования.
- В примере ниже показан псевдо-провайдер и способ регистрации в рантайме.

Example usage (псевдокод)

1) Зарегистрируйте provider в конфигурации приложения

```ts
import { configureEntities, YdbCoreModule } from 'ydb-orm';
import { MyKmsProvider } from './kms-provider';

const provider = new MyKmsProvider({ keyId: process.env.KMS_KEY_ID });

YdbCoreModule.forRoot({
  encryptionProvider: provider,
  // ...other options (executor, blindIndexProvider ...)
});
```

2) Отметьте поля в сущности

```ts
import { YdbEntity } from '../../src/decorators/entity.decorator.js';
import { YdbColumn, YdbPrimaryColumn } from '../../src/decorators/column.decorator.js';
import { YdbEncrypted } from '../../src/decorators/encrypted.decorator.js';

@YdbEntity('users')
class UserEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  @YdbEncrypted({ blindIndex: true })
  email: string;
}
```

3) Ротация ключей
- Реализуйте в провайдере метод rotateKey(oldKeyId, newKeyId) который сможет декодировать существующие шифротексты и рекомпоновать их с новым мастер-ключом.
- Ротация выполняется построчно или батчами: читать строки, дешифровать и снова зашифровать с новым ключом.

Testing locally
- Для локальной разработки можно использовать "dev" провайдер, который просто использует симметричный ключ из .env, или mock-провайдер.
- В документации KMS вашего облака есть инструкции для генерации тестовых ключей.
