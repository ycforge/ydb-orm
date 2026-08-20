import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbJson,
  YdbBaseEntity,
} from '../../../src/index.js';

@YdbEntity('json_doc_test')
export class JsonDocEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  /** Хранится как JSON-строка в Utf8 (ORM сериализует/парсит). */
  @YdbJson()
  @YdbColumn('Utf8')
  metadata!: Record<string, any>;

  /** Нативный YDB Json. */
  @YdbColumn('Json')
  payload!: any;

  /** Нативный YDB JsonDocument. */
  @YdbColumn('JsonDocument')
  document!: any;
}
