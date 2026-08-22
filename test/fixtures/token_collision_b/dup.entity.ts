// Фикстура для регрессионных тестов коллизии DI-токенов (#94).
// Имя класса намеренно совпадает с DupEntity из ../token_collision_a/dup.entity.ts.
import {
  YdbEntity,
  YdbPrimaryColumn,
  YdbColumn,
  YdbBaseEntity,
} from '../../../src/index.js';

@YdbEntity('token_dup_b')
export class DupEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  title!: string;
}
