/**
 * Человекочитаемый цветной вывод расхождений схемы «сущности vs БД»
 * для команд CLI (`schema:verify`, `migration:generate`).
 * ANSI-коды вручную, без зависимостей; цвет отключается при не-TTY
 * выводе и по переменной окружения NO_COLOR.
 */
import type { YdbSchemaIssue } from '../schema/schema-sync.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const GRAY = '\x1b[90m';

/** Маркер и цвет по типу расхождения. */
const KIND_STYLE: Record<
  YdbSchemaIssue['kind'],
  { marker: string; color: string }
> = {
  'missing-table': { marker: '✖', color: RED },
  'missing-column': { marker: '+', color: YELLOW },
  'missing-index': { marker: '+', color: YELLOW },
  'ttl-missing': { marker: '+', color: YELLOW },
  'type-mismatch': { marker: '~', color: RED },
  'index-columns-mismatch': { marker: '~', color: RED },
  'unique-mismatch': { marker: '~', color: RED },
  'ttl-mismatch': { marker: '~', color: RED },
  'primary-key-mismatch': { marker: '!', color: RED },
  'rename-suggestion': { marker: '~', color: YELLOW },
  'extra-column': { marker: '-', color: GRAY },
  'extra-index': { marker: '-', color: BLUE },
  'ttl-extra': { marker: '-', color: BLUE },
};

/**
 * Цвет включён, только если целевой поток вывода — TTY и не задана
 * NO_COLOR (#103). Раньше TTY проверялся только у stdout, хотя расхождения
 * в schema:verify пишутся в stderr — при перенаправлении stdout ANSI-коды
 * попадали в файл, а при перенаправлении stderr цвет зря отключался.
 */
export function shouldUseColor(
  stream: NodeJS.WriteStream = process.stdout,
): boolean {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR;
}

/** Оборачивает текст в ANSI-цвет, если раскраска включена. */
function paint(text: string, color: string, colorEnabled: boolean): string {
  return colorEnabled ? `${color}${text}${RESET}` : text;
}

/** Убирает префикс `Table "<name>" ` из сообщения — таблица уже в заголовке группы. */
function stripTablePrefix(issue: YdbSchemaIssue): string {
  return issue.message.replace(`Table "${issue.tableName}" `, '');
}

/**
 * Для type-mismatch переформатирует сообщение в «было → стало»:
 * `column "c" type mismatch: expected Utf8, actual Int32`
 * → `column "c": Int32 → Utf8`.
 * Аналогично для index-columns-mismatch:
 * `index "i" columns mismatch: expected [a, b], actual [b, a]`
 * → `index "i": [b, a] → [a, b]`,
 * и для ttl-mismatch:
 * `TTL mismatch: expected PT2H ..., actual P1D ...`
 * → `TTL: P1D ... → PT2H ...`.
 */
function formatIssueText(issue: YdbSchemaIssue): string {
  const text = stripTablePrefix(issue);
  if (issue.kind === 'type-mismatch') {
    const match =
      /column "(.+)" type mismatch: expected (.+), actual (.+)$/.exec(text);
    if (match) {
      return `column "${match[1]}": ${match[3]} → ${match[2]}`;
    }
  }
  if (issue.kind === 'index-columns-mismatch') {
    const match =
      /index "(.+)" columns mismatch: expected (\[.*\]), actual (\[.*\])$/.exec(
        text,
      );
    if (match) {
      return `index "${match[1]}": ${match[3]} → ${match[2]}`;
    }
  }
  if (issue.kind === 'ttl-mismatch') {
    const match = /TTL mismatch: expected (.+), actual (.+)$/.exec(text);
    if (match) {
      return `TTL: ${match[2]} → ${match[1]}`;
    }
  }
  return text;
}

/**
 * Рендерит список расхождений, сгруппированный по таблицам.
 * Возвращает многострочную строку (без завершающего перевода строки).
 *
 * Цвет определяется по потоку, куда вывод реально попадает: опция
 * `stream` (по умолчанию stdout) или явный `color`.
 */
export function renderSchemaDiff(
  issues: YdbSchemaIssue[],
  options?: { color?: boolean; stream?: NodeJS.WriteStream },
): string {
  const colorEnabled = options?.color ?? shouldUseColor(options?.stream);

  // Группировка по таблицам с сохранением исходного порядка.
  const byTable = new Map<string, YdbSchemaIssue[]>();
  for (const issue of issues) {
    const list = byTable.get(issue.tableName) ?? [];
    list.push(issue);
    byTable.set(issue.tableName, list);
  }

  const lines: string[] = [];
  for (const [tableName, tableIssues] of byTable) {
    lines.push(paint(tableName, BOLD, colorEnabled));
    for (const issue of tableIssues) {
      const style = KIND_STYLE[issue.kind];
      const marker = paint(style.marker, style.color, colorEnabled);
      lines.push(`  ${marker} ${formatIssueText(issue)}`);
    }
  }
  return lines.join('\n');
}
