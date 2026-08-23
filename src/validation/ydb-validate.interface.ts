/**
 * Структурированная ошибка валидации одного свойства сущности.
 * Сохраняет property/constraint для машинной обработки (например,
 * маппинга в HTTP 400) — в отличие от плоского списка строк (#95).
 */
export interface YdbValidationErrorItem {
  /** Имя свойства сущности, не прошедшего валидацию (пусто — если провайдер не сообщает). */
  property: string;
  /** Тип нарушения: ключ constraint (например, 'isNotEmpty', 'minLength'). */
  constraint: string;
  /** Человекочитаемое сообщение об ошибке. */
  message: string;
  /** Значение свойства на момент валидации (контекст; не попадает в message). */
  value?: unknown;
}

/**
 * Элемент результата провайдера валидации.
 * Строка — legacy-формат (обратная совместимость с провайдерами до #95),
 * объект — структурированный формат.
 */
export type YdbValidationIssue = string | YdbValidationErrorItem;

export interface YdbValidationProvider {
  /**
   * Валидирует сущность и возвращает список нарушений.
   * Пустой массив — сущность валидна.
   */
  validate(entity: any): Promise<YdbValidationIssue[]>;
}

export interface YdbValidationOptions {
  groups?: string[];
  /**
   * Пропускать проверку отсутствующих (undefined/null) свойств.
   *
   * По умолчанию `false` — безопасный явный дефолт (#95): при save()
   * нового объекта @IsNotEmpty/@IsDefined на незаполненных полях
   * не проходят валидацию. `true` восстанавливает поведение до #95
   * (раньше это значение было жёстко зашито).
   */
  skipMissingProperties?: boolean;
}
