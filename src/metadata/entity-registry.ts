/**
 * Реестр сущностей: декоратор @YdbEntity регистрирует класс в момент
 * загрузки модуля. Нужен schema sync (опция `sync` в forRoot), чтобы
 * находить все сущности без явного списка entities в опциях модуля.
 *
 * Важно: класс попадает в реестр только если его файл был импортирован
 * (обычно это происходит через YdbModule.forFeature / импорты модулей NestJS).
 *
 * Владение сущностями (#142): у каждого экземпляра YdbCoreModule (то есть
 * у каждого Nest-приложения) есть собственный скоуп — createEntityScope()
 * вызывается на статической стороне forRootAsync, а провайдеры forFeature
 * привязывают сущности к скоупу СВОЕГО приложения через DI-токен
 * YDB_CORE_SCOPE. Порядок резолва провайдеров роли не играет: сущность
 * физически не может попасть в чужое приложение. Приложение, упавшее
 * с Duplicate YDB module initialization, уносит свои привязки с собой.
 *
 * Вне активного приложения (CLI, standalone, unit-тесты)
 * getRegisteredYdbEntities() без аргумента возвращает весь глобальный
 * реестр — прежнее поведение; повторная регистрация идемпотентна (Set).
 */
type EntityCtor = new (...args: any[]) => any;

/** Все задекорированные классы за жизнь процесса (никогда не чистится). */
const registry = new Set<EntityCtor>();

/** Скоуп сущностей одного приложения: обычный Set, им владеет его ядро. */
export type YdbEntityAppScope = Set<EntityCtor>;

/** Создаёт пустой скоуп для нового экземпляра ядра (вызов из forRootAsync). */
export function createEntityScope(): YdbEntityAppScope {
  return new Set<EntityCtor>();
}

export function registerYdbEntity(target: EntityCtor): void {
  // Декоратор выполняется при загрузке модуля и не знает ни про одно
  // приложение — регистрация только процессно-глобальная. Привязку к
  // конкретному приложению делает YdbModule.forFeature (#142).
  registry.add(target);
}

/**
 * Явно привязывает сущности к скоупу конкретного приложения (#142).
 *
 * Вызывается из фабрики AR-провайдера (YdbModule.forFeature): декоратор
 * @YdbEntity выполняется один раз за жизнь процесса (кеш ESM-модулей),
 * поэтому повторное приложение в том же процессе не «перерегистрирует»
 * свои сущности само — без явной привязки schema sync увидел бы пустой
 * набор. Скоуп приходит через DI-токен YDB_CORE_SCOPE и гарантированно
 * принадлежит контейнеру того приложения, в котором создан провайдер,
 * поэтому привязка корректна и ДО claim ядра (сущность просто ждёт в
 * скоупе будущего приложения), и после него.
 */
export function requestEntitiesForApp(
  scope: YdbEntityAppScope,
  entities: readonly EntityCtor[],
): void {
  for (const entity of entities) {
    registry.add(entity);
    scope.add(entity);
  }
}

/**
 * Сущности для schema sync/verify. С аргументом — набор конкретного
 * приложения; без аргумента (CLI, standalone) — весь глобальный реестр.
 */
export function getRegisteredYdbEntities(
  scope?: YdbEntityAppScope,
): EntityCtor[] {
  if (scope) {
    return [...scope];
  }
  return [...registry];
}
