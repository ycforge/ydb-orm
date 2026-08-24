import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbTtl,
} from '../../../src/index.js';

/**
 * Фикстура #109: сущность с TTL по Datetime-колонке.
 * Используется в сценарных тестах schema sync (DDL c WITH (TTL = ...)).
 */

@YdbEntity('fixture_ttl_docs')
@YdbTtl({ interval: 'P7D', column: 'expires_at' })
export class TtlDocumentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  body: string;

  @YdbColumn('Datetime')
  expires_at: Date;
}
