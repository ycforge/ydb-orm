/**
 * Глобальный реестр сущностей: декоратор @YdbEntity регистрирует класс
 * в момент загрузки модуля. Нужен schema sync (опция `sync` в forRoot),
 * чтобы находить все сущности без явного списка entities в опциях модуля.
 *
 * Важно: класс попадает в реестр только если его файл был импортирован
 * (обычно это происходит через YdbModule.forFeature / импорты модулей NestJS).
 *
 * Жизненный цикл (#142): у реестра есть граница владения, привязанная к
 * YdbCoreModule (см. module/core-module-registry). Пока приложение живо,
 * sync видит только его сущности; после shutdown набор сбрасывается, и
 * следующее независимое приложение в том же процессе не наследует чужие
 * сущности. Повторная регистрация одного класса идемпотентна (Set).
 * Вне активного приложения (CLI, standalone, unit-тесты) getRegistered...()
 * возвращает весь глобальный реестр — прежнее поведение.
 */
type EntityCtor = new (...args: any[]) => any;

/** Все задекорированные классы за жизнь процесса (никогда не чистится). */
const registry = new Set<EntityCtor>();

/**
 * Сущности активного приложения (создаётся beginEntityScope при claim ядра).
 * Классы, задекорированные уже ПОСЛЕ claim (поздние импорты), попадают сюда
 * же — они часть текущего приложения и видны его schema sync.
 */
let activeScope: Set<EntityCtor> | null = null;

/** Сущности, зарегистрированные вне активного приложения. */
const detached = new Set<EntityCtor>();

export function registerYdbEntity(target: EntityCtor): void {
  registry.add(target);
  if (activeScope) {
    activeScope.add(target);
  } else {
    detached.add(target);
  }
}

/**
 * Открывает скоуп сущностей для нового экземпляра ядра: забирает всё,
 * что накопилось вне приложений (обычно импорты forFeature перед compile).
 */
export function beginEntityScope(): void {
  if (!activeScope) {
    activeScope = new Set<EntityCtor>();
  }
  for (const entity of detached) {
    activeScope.add(entity);
  }
  detached.clear();
}

/**
 * Закрывает скоуп приложения: его сущности больше не видны schema sync —
 * следующее приложение в этом процессе стартует с чистым набором.
 */
export function endEntityScope(): void {
  activeScope = null;
  detached.clear();
}

export function getRegisteredYdbEntities(): EntityCtor[] {
  if (!activeScope) {
    return [...registry];
  }
  return [...new Set([...activeScope, ...detached])];
}
