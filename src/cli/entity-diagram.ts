/**
 * entity:diagram (#36): read-only rendering of canonical entity metadata
 * into a Mermaid ER diagram.
 *
 * Guarantees:
 *  - NO DB I/O whatsoever: no driver, no executor, no DDL, no migrations —
 *    the function is synchronous and works only with class metadata;
 *  - the only data source is the canonical metadata:dump (#37)
 *    (buildMetadataDump): the decorator walk is not duplicated; all the
 *    strict validation (class without @YdbEntity, table-name conflict #92,
 *    missing PK, join columns #87, join tables #90/#139) is inherited from
 *    there — invalid metadata fails the command before the first byte of
 *    output;
 *  - determinism: stable ordering of entity blocks, columns and relations —
 *    calling the function again on the same entities yields a byte-identical
 *    diagram, and the input list order does not affect the output;
 *  - valid Mermaid for arbitrary names: table names/relation labels are
 *    always double-quoted with escaping, column names are normalized to a
 *    permissible form (the original is kept as a comment) — malformed
 *    output is impossible.
 */

import fs from 'node:fs';
import { buildMetadataDump } from './metadata-dump.js';
import { compareStrings } from './sort.js';
import type {
  DumpedColumn,
  DumpedEntity,
  DumpedJoinTable,
  MetadataDump,
} from './metadata-dump.js';

type EntityCtor = new (...args: any[]) => any;

/**
 * Builds a Mermaid ER diagram for the given list of entities.
 *
 * The list defines the diagram composition (usually config.entities from
 * ydb-orm.config.ts); the output order does not depend on it. A pure
 * synchronous function: it never touches the DB and does not swallow
 * configuration errors (all of them surface from buildMetadataDump).
 */
export function buildEntityDiagram(entities: EntityCtor[]): string {
  const dump = buildMetadataDump(entities);
  return renderDiagram(dump);
}

/**
 * Writes the diagram to a file without risking a silent overwrite:
 * an existing file is an error (the 'wx' flag), the write is atomic w.r.t.
 * check-then-write.
 */
export function writeDiagramFile(filePath: string, diagram: string): void {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'wx');
  } catch (error) {
    // Check by code, not instanceof: in VM environments (jest ESM) a native
    // fs error may not inherit this context's Error.
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new Error(
        `File already exists: ${filePath} — entity:diagram never overwrites ` +
          `existing files.`,
      );
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${diagram}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

// ─────────────────────────── Rendering ──────────────────────────────────────

/** One edge on the diagram: `left <cardinality> right : label`. */
interface DiagramEdge {
  left: string;
  leftCard: string;
  line: '--';
  rightCard: string;
  right: string;
  label: string;
}

function renderDiagram(dump: MetadataDump): string {
  const lines: string[] = ['erDiagram'];

  // Physical FK columns of relations — for FK markers in blocks.
  const foreignKeys = collectForeignKeys(dump.entities);

  // Entity blocks: ordinary tables first, then m2m join tables; each group
  // is sorted by table name (determinism).
  for (const entity of dump.entities) {
    lines.push(...renderEntityBlock(entity, foreignKeys.get(entity.table)));
  }
  for (const joinTable of dump.joinTables) {
    lines.push(...renderJoinTableBlock(joinTable));
  }

  for (const edge of collectEdges(dump)) {
    lines.push(renderEdge(edge));
  }

  return lines.join('\n');
}

/**
 * Collects, per table, the set of its FK columns — for FK markers in blocks:
 * many-to-one/one-to-one keep the FK on their own side, while in one-to-many
 * the column physically lives in the target table (if the latter is part of
 * the diagram). Edge direction and cardinality are computed separately.
 */
function collectForeignKeys(
  entities: DumpedEntity[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const ensure = (table: string): Set<string> => {
    let fks = result.get(table);
    if (!fks) {
      fks = new Set();
      result.set(table, fks);
    }
    return fks;
  };
  for (const entity of entities) ensure(entity.table);
  for (const entity of entities) {
    for (const relation of entity.relations) {
      if (relation.joinColumn === undefined) continue;
      switch (relation.type) {
        case 'many-to-one':
        case 'one-to-one':
          ensure(entity.table).add(relation.joinColumn);
          break;
        case 'one-to-many': {
          const targetFks = result.get(relation.target.table);
          if (targetFks) targetFks.add(relation.joinColumn);
          break;
        }
        default:
          break;
      }
    }
  }
  return result;
}

/**
 * Entity block: PK columns come first in declaration order (composite-PK
 * order matters in YDB, #89), the rest alphabetically (as in the dump).
 */
function renderEntityBlock(
  entity: DumpedEntity,
  foreignKeys: Set<string> | undefined,
): string[] {
  const body = orderColumns(entity).map((column) =>
    renderAttribute(
      column,
      foreignKeys,
      entity.primaryKey.includes(column.name),
    ),
  );
  return [`  ${quoteMermaid(entity.table)} {`, ...body, '  }'];
}

/** Block columns: PK first in primaryKey order, the rest as in the dump. */
function orderColumns(entity: DumpedEntity): DumpedColumn[] {
  const byName = new Map(entity.columns.map((column) => [column.name, column]));
  const ordered: DumpedColumn[] = [];
  for (const name of entity.primaryKey) {
    const column = byName.get(name);
    if (column) ordered.push(column);
  }
  for (const column of entity.columns) {
    if (!entity.primaryKey.includes(column.name)) ordered.push(column);
  }
  return ordered;
}

/** Attribute line: type, name, keys (PK/FK), comment with original. */
function renderAttribute(
  column: DumpedColumn,
  foreignKeys: Set<string> | undefined,
  isPrimary = false,
): string {
  const keys: string[] = [];
  if (isPrimary) keys.push('PK');
  if (foreignKeys?.has(column.name)) keys.push('FK');
  return renderAttributeLine(column.type, column.name, keys);
}

/**
 * Universal attribute line: `    <type> <name>[ PK[, FK][ "original"]]`.
 * Name cannot be quoted — original preserved as comment during sanitization.
 */
function renderAttributeLine(
  rawType: string,
  rawName: string,
  keys: string[],
): string {
  const type = sanitizeWord(rawType, 'string');
  const safe = sanitizeAttributeName(rawName);

  const parts = [`    ${type} ${safe.name}`];
  if (keys.length) parts.push(` ${keys.join(', ')}`);
  // Preserve the original name as a comment: the sanitized name may
  // differ from the physical column.
  if (safe.changed) parts.push(` ${quoteMermaid(rawName)}`);
  return parts.join('');
}

/** Physical many-to-many join table block: both columns are PK + FK. */
function renderJoinTableBlock(joinTable: DumpedJoinTable): string[] {
  return [
    `  ${quoteMermaid(joinTable.table)} {`,
    renderAttributeLine(joinTable.joinColumnType, joinTable.joinColumn, [
      'PK',
      'FK',
    ]),
    renderAttributeLine(
      joinTable.inverseJoinColumnType,
      joinTable.inverseJoinColumn,
      ['PK', 'FK'],
    ),
    '  }',
  ];
}

// ────────────────────────────── Relations ────────────────────────────────────

/**
 * Diagram edges, deterministically ordered.
 *
 *  - one-to-many ↔ many-to-one with the same FK column yield one line:
 *    if the "child" side (FK owner) is in the dump, its many-to-one draws the
 *    line; unidirectional one-to-many (no reverse many-to-one) draws from
 *    the parent. Cardinality is always ||--o{ (parent on the left).
 *  - one-to-one: ||--o| (FK is unique, no nullable semantics in metadata);
 *    bidirectional one-to-one with two different FK columns yields two lines
 *    — these are two physical relationships.
 *  - many-to-many is drawn via the physical join table with two lines
 *    ||--o{ (owner → join → inverse side); the list properties themselves
 *    do not generate separate lines.
 */
function collectEdges(dump: MetadataDump): DiagramEdge[] {
  const edges: DiagramEdge[] = [];

  // Keys of edges already drawn by the FK-owning side:
  // "<parent>|<child>|<fk>" — so the paired one-to-many doesn't duplicate.
  const fkOwnedEdges = new Set<string>();

  for (const entity of dump.entities) {
    for (const relation of entity.relations) {
      switch (relation.type) {
        case 'many-to-one':
          edges.push({
            left: relation.target.table,
            leftCard: '||',
            line: '--',
            rightCard: 'o{',
            right: entity.table,
            label: relation.property,
          });
          fkOwnedEdges.add(
            `${relation.target.table}|${entity.table}|${relation.joinColumn}`,
          );
          break;
        case 'one-to-one':
          edges.push({
            left: relation.target.table,
            leftCard: '||',
            line: '--',
            rightCard: 'o|',
            right: entity.table,
            label: relation.property,
          });
          fkOwnedEdges.add(
            `${relation.target.table}|${entity.table}|${relation.joinColumn}`,
          );
          break;
        default:
          break;
      }
    }
  }

  for (const entity of dump.entities) {
    for (const relation of entity.relations) {
      if (relation.type !== 'one-to-many') continue;
      const key = `${entity.table}|${relation.target.table}|${relation.joinColumn}`;
      if (fkOwnedEdges.has(key)) continue;
      edges.push({
        left: entity.table,
        leftCard: '||',
        line: '--',
        rightCard: 'o{',
        right: relation.target.table,
        label: relation.property,
      });
    }
  }

  for (const joinTable of dump.joinTables) {
    edges.push({
      left: joinTable.owner.table,
      leftCard: '||',
      line: '--',
      rightCard: 'o{',
      right: joinTable.table,
      label: joinTable.joinColumn,
    });
    edges.push({
      left: joinTable.table,
      leftCard: '||',
      line: '--',
      rightCard: 'o{',
      right: joinTable.inverse.table,
      label: joinTable.inverseJoinColumn,
    });
  }

  return edges.sort(
    (a, b) =>
      compareStrings(a.left, b.left) ||
      compareStrings(a.right, b.right) ||
      compareStrings(a.label, b.label) ||
      compareStrings(a.rightCard, b.rightCard),
  );
}

function renderEdge(edge: DiagramEdge): string {
  return (
    `  ${quoteMermaid(edge.left)} ${edge.leftCard}${edge.line}` +
    `${edge.rightCard} ${quoteMermaid(edge.right)} : ${quoteMermaid(edge.label)}`
  );
}

// ─────────────────────── Escaping and sanitization ──────────────────────────

/**
 * Table/entity name, relation label (after colon), or attribute comment
 * in Mermaid ER: always double-quoted — safe for spaces, dots, dashes,
 * unicode and any other characters except the double quote itself and
 * newlines, which are replaced.
 */
function quoteMermaid(value: string): string {
  // A double quote would close the string; newlines break the single-line form.
  return `"${value.replace(/"/g, "'").replace(/\s+/g, ' ').trim()}"`;
}

const ATTRIBUTE_SAFE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Attribute name in a Mermaid ER block cannot be quoted — grammar requires
 * a word of letters/digits/underscores starting with a letter. Invalid
 * characters are replaced with '_'; changed name is flagged so the renderer
 * adds a comment with the original. Empty name is impossible: fallback
 * guarantees a word.
 */
function sanitizeAttributeName(name: string): {
  name: string;
  changed: boolean;
} {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  let candidate = cleaned === '' ? '_' : cleaned;
  if (!/^[A-Za-z]/.test(candidate)) candidate = `c_${candidate}`;
  return { name: candidate, changed: candidate !== name };
}

/**
 * YDB primitive when rendered — just a simple word (Utf8, Int32, ...), but
 * render guards against unexpected values too: malformed output is always
 * excluded.
 */
function sanitizeWord(value: string, fallback: string): string {
  return ATTRIBUTE_SAFE.test(value) ? value : fallback;
}
