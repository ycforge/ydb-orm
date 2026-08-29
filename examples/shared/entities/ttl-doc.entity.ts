/**
 * Документ с TTL (@YdbTtl): строки, у которых `expires_at` старше
 * заданного интервала, YDB удалит автоматически. Здесь интервал — P7D
 * (7 дней), колонка даты/времени — `expires_at` (Datetime).
 */
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbTtl,
  YdbBaseEntity,
} from '../../../src/index.js';

@YdbEntity('ttl_docs')
@YdbTtl({ interval: 'P7D', column: 'expires_at' })
export class TtlDocEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  body: string;

  /** Дата и время удаления записи (TTL). */
  @YdbColumn('Datetime')
  expires_at: Date;
}
