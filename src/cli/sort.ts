/**
 * Детерминированное сравнение строк для сортировки (порядок code points):
 * в отличие от localeCompare не зависит от локали рантайма — повторный
 * запуск в любом окружении даёт побайтово одинаковый вывод.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
