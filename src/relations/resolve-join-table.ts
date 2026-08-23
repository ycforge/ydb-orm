import type { YdbBaseEntity } from '../entity/base-entity.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import {
  assertNoForeignJoinTableConflicts,
  getManyToManyJoinTables,
} from '../decorators/relation.decorators.js';
import type { YdbPrimitive } from '../core/types.js';

/**
 * Метаданные join-таблицы many-to-many, ориентированные относительно
 * запрашиваемой сущности (owner).
 *
 * Вынесено из entity-relations в отдельный модуль (#17): related-фильтры
 * в entity-persistence используют тот же резолв, что и eager/lazy-загрузка,
 * а прямой импорт entity-relations из persistence породил бы цикл.
 */
export interface ResolvedJoinTable {
  tableName: string;
  ownerColumn: string;
  inverseColumn: string;
  /**
   * YDB-тип owner-колонки join-таблицы (#90): тип PK owner-сущности.
   * Схема join-таблицы (schema sync) выводит те же имена и типы, поэтому
   * чтение всегда совместимо со сгенерированной таблицей.
   */
  ownerColumnType: YdbPrimitive;
  ownerEntity: typeof YdbBaseEntity;
  inverseEntity: typeof YdbBaseEntity;
}

/**
 * Находит метаданные join-таблицы для many-to-many.
 *
 * Валидация и разрешение конфликтов выполняются тем же кодом, что и при
 * генерации схемы: getManyToManyJoinTables для пары сущностей. Поэтому
 * рантайм не может молча выбрать одно из расходящихся объявлений таблицы —
 * он упадёт с той же ошибкой конфликта, что и schema sync/migrations (#139).
 */
export function resolveManyToManyJoinTable(
  owner: typeof YdbBaseEntity,
  relation: { propertyKey: string; target: () => typeof YdbBaseEntity },
): ResolvedJoinTable | undefined {
  const ownerMeta = getYdbEntityMetadata(owner);
  const inverseEntity = relation.target();
  const inverseMeta = getYdbEntityMetadata(inverseEntity);
  if (!ownerMeta || !inverseMeta) return undefined;

  // Все объявления join-таблиц, видимые для пары (владелец, inverse):
  // здесь же проверяются PK и конфликты объявлений одного имени (#90/#139).
  const definitions = getManyToManyJoinTables([owner, inverseEntity]);

  // Декларация на самом владельце для этой связи.
  const own = definitions.find(
    (d) => d.ownerEntity === owner && d.ownerProperty === relation.propertyKey,
  );
  if (own) {
    assertNoForeignJoinTableConflicts(own);
    return {
      tableName: own.tableName,
      ownerColumn: own.joinColumn,
      inverseColumn: own.inverseJoinColumn,
      // Имя, тип и сущности берутся из того же определения, по которому
      // строится схема join-таблицы (#87): расхождений между рантаймом
      // и schema sync быть не может.
      ownerColumnType: own.joinColumnType,
      ownerEntity: owner,
      inverseEntity,
    };
  }

  // Зеркальная декларация на обратной стороне: колонки разворачиваются —
  // joinColumn объявления принадлежит inverse-сущности, inverseJoinColumn — владельцу.
  const inverseOwned = definitions.find(
    (d) => d.ownerEntity === inverseEntity && d.inverseEntity === owner,
  );
  if (inverseOwned) {
    assertNoForeignJoinTableConflicts(inverseOwned);
    return {
      tableName: inverseOwned.tableName,
      ownerColumn: inverseOwned.inverseJoinColumn,
      inverseColumn: inverseOwned.joinColumn,
      // Тип owner-колонки = тип PK владельца = тип её колонки в объявлении.
      ownerColumnType: inverseOwned.inverseJoinColumnType,
      ownerEntity: owner,
      inverseEntity,
    };
  }

  return undefined;
}
