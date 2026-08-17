/**
 * Корневой модуль примера 1 (базовый CRUD).
 * - YdbModule.forRoot — глобальный корневой модуль (endpoint, auth,
 *   провайдеры, sync). forFeature — инжектирует executor/провайдеры в сущности.
 */
import { Module } from '@nestjs/common';
import { YdbModule } from '../../src/index.js';
import { PostEntity } from '../entities/index.js';
import { PostService } from './post.service.js';
import { createEncryptionProvider } from '../providers/aes-gcm-encryption.provider.js';

@Module({
  imports: [
    YdbModule.forRoot({
      useFactory: () => ({
        endpoint: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136/local',
        auth_type: 'anonymous',
        authOptions: {},
        // Автоматическое создание/правка схемы при старте приложения.
        // В проде вместо sync используйте миграции.
        sync: true,
        encryptionProvider: createEncryptionProvider(),
        blindIndexProvider: createEncryptionProvider(),
      }),
    }),
    YdbModule.forFeature([PostEntity]),
  ],
  providers: [PostService],
})
export class AppModule {}
