/**
 * Корневой модуль примера 4 (создание схемы БД).
 */
import { Module } from '@nestjs/common';
import { createAuth } from '@ycforge/auth';
import { YdbModule } from '../../src/index.js';
import { UserEntity, PostEntity, ProfileEntity } from '../entities/index.js';
import { SchemaService } from './schema.service.js';
import { createEncryptionProvider } from '../providers/aes-gcm-encryption.provider.js';

@Module({
  imports: [
    YdbModule.forRoot({
      useFactory: () => ({
        endpoint: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136/local',
        auth: createAuth({ type: 'anonymous' }),
        // Автоматическая синхронизация при старте: создаёт недостающие
        // таблицы (users, posts, profiles) и колонки, включая synthetic
        // `{field}_bi` колонки blind index.
        sync: true,
        encryptionProvider: createEncryptionProvider(),
        blindIndexProvider: createEncryptionProvider(),
      }),
    }),
    YdbModule.forFeature([UserEntity, PostEntity, ProfileEntity]),
  ],
  providers: [SchemaService],
})
export class AppModule {}
