/**
 * Глобальный реестр сущностей: декоратор @YdbEntity регистрирует класс
 * в момент загрузки модуля. Нужен schema sync (опция `sync` в forRoot),
 * чтобы находить все сущности без явного списка entities в опциях модуля.
 *
 * Важно: класс попадает в реестр только если его файл был импортирован
 * (обычно это происходит через YdbModule.forFeature / импорты модулей NestJS).
 */
const registry = new Set<new (...args: any[]) => any>();

export function registerYdbEntity(target: new (...args: any[]) => any): void {
  registry.add(target);
}

export function getRegisteredYdbEntities(): (new (...args: any[]) => any)[] {
  return [...registry];
}
