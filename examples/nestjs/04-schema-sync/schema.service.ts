/**
 * Сервис проверки схемы: ручная verify() через YDB_SCHEMA_SYNC.
 * При старте приложения sync уже отработал (sync: true в опциях),
 * поэтому verify() обычно возвращает пустой список.
 */
import { Inject, Injectable } from '@nestjs/common';
import { YDB_SCHEMA_SYNC, YdbSchemaSyncer } from '../../../src/nest/index.js';
import { ArticleEntity, TtlDocEntity } from '../../shared/entities/index.js';

@Injectable()
export class SchemaService {
  constructor(
    @Inject(YDB_SCHEMA_SYNC)
    private readonly syncer: YdbSchemaSyncer,
  ) {}

  async check(): Promise<string[]> {
    const issues = await this.syncer.verify([ArticleEntity, TtlDocEntity]);
    return issues.map((issue) => issue.message);
  }
}
