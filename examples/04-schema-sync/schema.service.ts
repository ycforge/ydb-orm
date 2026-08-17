/**
 * Сервис примера 4: создание схемы БД (schema sync) — аналог `synchronize`
 * в TypeORM.
 *
 * Два способа:
 *  1) `sync: true` в опциях forRoot — таблицы/колонки подстраиваются
 *     автоматически при старте приложения (CREATE TABLE, ALTER TABLE ADD COLUMN).
 *  2) Инжектировать YdbSchemaSyncer (токен YDB_SCHEMA_SYNC) и вызвать
 *     `verify(entities)` (проверка без изменений) или `sync(entities)` вручную.
 *
 * Ограничения (в YDB нельзя менять):
 *  - тип колонки — ошибка, нужна ручная миграция;
 *  - первичный ключ — ошибка, нужна ручная миграция;
 *  - лишние колонки в БД не удаляются (только предупреждение в лог).
 *
 * В проде используйте миграции вместо sync: true.
 */
import { Injectable, Inject } from '@nestjs/common';
import { YDB_SCHEMA_SYNC, YdbSchemaSyncer } from '../../src/index.js';
import { UserEntity, PostEntity, ProfileEntity } from '../entities/index.js';

@Injectable()
export class SchemaService {
  constructor(
    // Провайдер экспортируется корневым модулем — можно проверить схему вручную.
    @Inject(YDB_SCHEMA_SYNC)
    private readonly syncer: YdbSchemaSyncer,
  ) {}

  /** verify(): только проверяет схему, ничего не меняет. */
  async check(): Promise<void> {
    const issues = await this.syncer.verify([
      UserEntity,
      PostEntity,
      ProfileEntity,
    ]);
    console.log('Проблемы схемы:', issues);
  }

  /** sync(): принудительно подстраивает схему. */
  async apply(): Promise<void> {
    await this.syncer.sync([UserEntity, PostEntity, ProfileEntity]);
    console.log('Схема синхронизирована');
  }
}
