/**
 * NestJS-пример 03: шифрование через DI-провайдеры.
 *
 * Провайдеры шифрования (encryptionProvider/blindIndexProvider) передаются
 * в опции модуля. Repo по полю с blind index сам рассчитает hash и найдёт
 * по synthetic-колонке; поле без blind index искать нельзя.
 * Ключи — из env: YDB_ORM_ENC_KEY / YDB_ORM_BI_KEY (base64, 32 байта).
 */
import { Module } from '@nestjs/common';
import { createEncryptionProvider } from '../../shared/providers/aes-gcm-encryption.provider.js';
import { EncryptedUserEntity } from '../../shared/entities/index.js';
import { buildYdbOptions } from '../../shared/options.js';
import { YdbOrmModule } from '../../../src/nest/index.js';
import { UserService } from './user.service.js';

@Module({
  imports: [
    YdbOrmModule.forRoot({
      useFactory: () => {
        // Оба интерфейса (encryption + blind index) реализует один класс.
        const providers = createEncryptionProvider();
        return {
          ...buildYdbOptions(),
          sync: true,
          encryptionProvider: providers,
          blindIndexProvider: providers,
        };
      },
    }),
    YdbOrmModule.forFeature([EncryptedUserEntity]),
  ],
  providers: [UserService],
})
export class AppModule {}
