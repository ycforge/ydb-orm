/**
 * Корневой модуль примера 2 (relations).
 */
import { Module } from '@nestjs/common';
import { createAuth } from '@ycforge/auth';
import { YdbModule } from '../../src/index.js';
import { UserEntity, PostEntity, ProfileEntity } from '../entities/index.js';
import { RelationsService } from './relations.service.js';
import { createEncryptionProvider } from '../providers/aes-gcm-encryption.provider.js';

@Module({
  imports: [
    YdbModule.forRoot({
      useFactory: () => ({
        endpoint: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136/local',
        auth: createAuth({ type: 'anonymous' }),
        sync: true,
        encryptionProvider: createEncryptionProvider(),
        blindIndexProvider: createEncryptionProvider(),
      }),
    }),
    YdbModule.forFeature([UserEntity, PostEntity, ProfileEntity]),
  ],
  providers: [RelationsService],
})
export class AppModule {}
