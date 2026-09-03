/**
 * Human-readable colored output of schema "entity vs DB" discrepancies for
 * CLI commands (`schema:verify`, `migration:generate`).
 * ANSI codes are produced by hand, with no dependencies; color is disabled
 * on non-TTY output and by the NO_COLOR environment variable.
 */
import type { YdbSchemaIssue } from '../schema/schema-sync.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const GRAY = '\x1b[90m';

/** Marker and color per discrepancy kind. */
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
 * Color is enabled only when the target output stream is a TTY and NO_COLOR
 * is not set (#103). Previously TTY was checked only against stdout although
 * schema:verify writes discrepancies to stderr — ANSI codes leaked into a
 * file when redirecting stdout, and color was needlessly disabled when
 * redirecting stderr.
 */
export function shouldUseColor(
  stream: NodeJS.WriteStream = process.stdout,
): boolean {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR;
}

/** Wraps text in ANSI color, if coloring is enabled. */
function paint(text: string, color: string, colorEnabled: boolean): string {
  return colorEnabled ? `${color}${text}${RESET}` : text;
}

/** Strips the `Table "<name>" ` prefix from the message — the table is already in the group heading. */
function stripTablePrefix(issue: YdbSchemaIssue): string {
  return issue.message.replace(`Table "${issue.tableName}" `, '');
}

/**
 * For type-mismatch, reformats the message as "was → became":
 * `column "c" type mismatch: expected Utf8, actual Int32`
 * → `column "c": Int32 → Utf8`.
 * Likewise for index-columns-mismatch:
 * `index "i" columns mismatch: expected [a, b], actual [b, a]`
 * → `index "i": [b, a] → [a, b]`,
 * and for ttl-mismatch:
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
 * Renders the list of discrepancies, grouped by table.
 * Returns a multi-line string (without a trailing newline).
 *
 * Color is decided by the stream the output actually lands in: the `stream`
 * option (defaults to stdout) or the explicit `color` option.
 */
export function renderSchemaDiff(
  issues: YdbSchemaIssue[],
  options?: { color?: boolean; stream?: NodeJS.WriteStream },
): string {
  const colorEnabled = options?.color ?? shouldUseColor(options?.stream);

  // Group by tables, preserving the original order.
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
