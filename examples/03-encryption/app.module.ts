/**
 * Корневой модуль примера 3 (шифрование полей).
 */
import { Module } from '@nestjs/common';
import { YdbModule } from '../../src/index.js';
import { UserEntity } from '../entities/index.js';
import { EncryptionService } from './encryption.service.js';
import { createEncryptionProvider } from '../providers/aes-gcm-encryption.provider.js';

@Module({
  imports: [
    YdbModule.forRoot({
      useFactory: () => ({
        endpoint: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136/local',
        auth_type: 'anonymous',
        authOptions: {},
        sync: true,
        encryptionProvider: createEncryptionProvider(),
        blindIndexProvider: createEncryptionProvider(),
      }),
    }),
    YdbModule.forFeature([UserEntity]),
  ],
  providers: [EncryptionService],
})
export class AppModule {}
