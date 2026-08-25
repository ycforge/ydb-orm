/**
 * entity:diagram (#36): read-only рендер канонических метаданных сущностей
 * в Mermaid ER-диаграмму.
 *
 * Гарантии:
 *  - НИКАКОГО I/O в БД: ни драйвера, ни executor'а, ни DDL, ни миграций —
 *    функция синхронная и работает только с метаданными классов;
 *  - единственный источник данных — канонический дамп metadata:dump (#37)
 *    (buildMetadataDump): обход декораторов не дублируется; вся строгая
 *    валидация (класс без @YdbEntity, конфликт таблиц #92, отсутствие PK,
 *    join-колонки #87, join-таблицы #90/#139) наследуется оттуда — невалидные
 *    метаданные роняют команду до первого байта вывода;
 *  - детерминизм: стабильный порядок блоков сущностей, колонок и связей —
 *    повторный вызов на тех же сущностях даёт побайтово одинаковую диаграмму,
 *    порядок входного списка на вывод не влияет;
 *  - корректный Mermaid для произвольных имён: имена таблиц/метки связей
 *    всегда в двойных кавычках с экранированием, имена колонок приводятся
 *    к допустимому виду (оригинал сохраняется комментарием) — malformed-
 *    вывод невозможен.
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
 * Строит Mermaid ER-диаграмму для переданного списка сущностей.
 *
 * Список задаёт состав диаграммы (обычно config.entities из yorm.config.ts);
 * порядок вывода от него не зависит. Чистая синхронная функция: БД не трогает,
 * ошибок конфигурации не глотает (все они всплывают из buildMetadataDump).
 */
export function buildEntityDiagram(entities: EntityCtor[]): string {
  const dump = buildMetadataDump(entities);
  return renderDiagram(dump);
}

/**
 * Записывает диаграмму в файл без риска молчаливой перезаписи:
 * существующий файл — ошибка (флаг 'wx'), запись атомарнее check-then-write.
 */
export function writeDiagramFile(filePath: string, diagram: string): void {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'wx');
  } catch (error) {
    // Проверка по коду без instanceof: в VM-окружениях (jest ESM) ошибка
    // из нативного fs может не наследовать Error этого контекста.
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

// ─────────────────────────── Рендеринг ──────────────────────────────────────

/** Одна связь на диаграмме: `left <cardinality> right : label`. */
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

  // Физические FK-колонки связей — для маркеров FK в блоках.
  const foreignKeys = collectForeignKeys(dump.entities);

  // Блоки сущностей: сначала обычные таблицы, затем join-таблицы m2m;
  // каждая группа отсортирована по имени таблицы (детерминизм).
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
 * Собирает по каждой таблице множество её FK-колонок — для маркеров FK
 * в блоках: many-to-one/one-to-one держат FK у себя, у one-to-many колонка
 * физически живёт в целевой таблице (если та участвует в диаграмме).
 * Направление и кратность связей считаются отдельно.
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
 * Блок сущности: PK-колонки идут первыми в порядке объявления (порядок
 * составного PK значим в YDB, #89), остальные — по алфавиту (как в дампе).
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

/** Колонки блока: PK — в порядке primaryKey, остальные — как в дампе. */
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

/** Строка атрибута: тип, имя, ключи (PK/FK), комментарий с оригиналом. */
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
 * Универсальная строка атрибута: `    <тип> <имя>[ PK[, FK][ "оригинал"]]`.
 * Имя квотировать нельзя — при санитизации оригинал сохраняется комментарием.
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
  // Оригинальное имя сохраняется комментарием: sanitized-имя может
  // отличаться от физической колонки.
  if (safe.changed) parts.push(` ${quoteMermaid(rawName)}`);
  return parts.join('');
}

/** Блок физической join-таблицы many-to-many: обе колонки — PK + FK. */
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

// ────────────────────────────── Связи ───────────────────────────────────────

/**
 * Связи диаграммы, детерминированно упорядоченные.
 *
 *  - one-to-many ↔ many-to-one с одной и той же FK-колонкой дают одну линию:
 *    если «дочерняя» сторона (владелец FK) входит в дамп, линию рисует её
 *    many-to-one; однонаправленный one-to-many (обратной many-to-one нет)
 *    рисуется от родителя. Кратность всегда ||--o{ (родитель слева).
 *  - one-to-one: ||--o| (FK уникален, nullable-семантика в метаданных
 *    отсутствует); двусторонние one-to-one с двумя разными FK-колонками дают
 *    две линии — это две физические связи.
 *  - many-to-many рисуется через физическую join-таблицу двумя линиями
 *    ||--o{ (владелец → join → обратная сторона); сами свойства-списки
 *    отдельных линий не порождают.
 */
function collectEdges(dump: MetadataDump): DiagramEdge[] {
  const edges: DiagramEdge[] = [];

  // Ключи линий, которые уже нарисованы стороной-владельцем FK:
  // "<parent>|<child>|<fk>" — чтобы парный one-to-many не задублировал линию.
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

// ─────────────────────── Экранирование и санитизация ───────────────────────

/**
 * Имя таблицы/сущности, метка связи (после двоеточия) или комментарий
 * атрибута в Mermaid ER: всегда в двойных кавычках — так безопасны пробелы,
 * точки, дефисы, юникод и любые другие символы, кроме самой двойной кавычки
 * и переводов строк, которые заменяются.
 */
function quoteMermaid(value: string): string {
  // Двойная кавычка закрыла бы строку; переводы строк ломают однострочность.
  return `"${value.replace(/"/g, "'").replace(/\s+/g, ' ').trim()}"`;
}

const ATTRIBUTE_SAFE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Имя атрибута в блоке Mermaid ER квотировать нельзя — грамматика требует
 * слово из букв/цифр/подчёркиваний, начинающееся с буквы. Недопустимые
 * символы заменяются на '_'; изменённое имя помечается, чтобы рендер добавил
 * комментарий с оригиналом. Пустое имя невозможно: fallback гарантирует слово.
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
 * YDB-примитив по построению — простое слово (Utf8, Int32, ...), но рендер
 * защищается и от неожиданного значения: malformed-вывод исключён всегда.
 */
function sanitizeWord(value: string, fallback: string): string {
  return ATTRIBUTE_SAFE.test(value) ? value : fallback;
}
