/**
 * NestJS-пример 01: базовый CRUD.
 *
 * Модуль: YdbOrmModule.forRoot(...) подключает ядро (driver + executor +
 * credentials) и включает schema sync при bootstrap.
 * YdbOrmModule.forFeature([...]) регистрирует репозитории сущностей —
 * они инжектятся в сервисы через @InjectRepository(Entity).
 */
import { Module } from '@nestjs/common';
import { PostEntity, UserEntity } from '../../shared/entities/index.js';
import { buildYdbOptions } from '../../shared/options.js';
import { YdbOrmModule } from '../../../src/nest/index.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [
    YdbOrmModule.forRoot({
      useFactory: () => ({
        ...buildYdbOptions(),
        sync: true, // создать недостающие таблицы при старте (dev-only)
      }),
    }),
    YdbOrmModule.forFeature([UserEntity, PostEntity]),
  ],
  providers: [UsersService],
})
export class AppModule {}
