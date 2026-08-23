/**
 * Интерактивный мастер entity:create (#24): ввод колонок
 * (имя → тип YDB → PK/encrypted/enum/date-колонки/TTL) и генерация файла.
 *
 * Гарантии:
 *  - валидация всех введённых определений ДО записи файла;
 *  - отмена/EOF (Ctrl+D/Ctrl+C) — чистый выход без записи;
 *  - существующий файл никогда не перезаписывается (проверка до старта
 *    мастера и защита в момент записи);
 *  - вне TTY ввод не читается вовсе: команда детерминированно создаёт
 *    шаблон по умолчанию и не зависает в ожидании ответов;
 *  - никаких обращений к БД и DDL — только локальная генерация файла.
 */
import fs from 'node:fs';
import { Writable } from 'node:stream';
import process from 'node:process';
import {
  CreatedFile,
  ENTITY_CREATE_TYPES,
  YdbEntityColumnSpec,
  YdbEntitySpec,
  buildDefaultEntitySpec,
  createEntityFileFromSpec,
  entityFilePath,
  renderEntityFile,
  toEnumMemberName,
  toSnakeCase,
  validateEntitySpec,
} from './generators.js';
import { PromptCancelledError, PromptIo, PromptReader } from './prompt.js';
import { validateTableName } from '../core/sql-utils.js';
import type { YdbPrimitive } from '../core/types.js';

const DATE_LIKE_TYPES = new Set<YdbPrimitive>([
  'Date',
  'Datetime',
  'Timestamp',
]);

export interface EntityCreateCommandOptions extends Partial<PromptIo> {
  /** Директория файла сущности. */
  dir: string;
  /**
   * Принудительный режим мастера. По умолчанию мастер запускается только
   * если input.isTTY — иначе создаётся шаблон по умолчанию без чтения ввода.
   */
  interactive?: boolean;
}

/**
 * Точка входа команды entity:create.
 *
 * TTY — интерактивный мастер; не-TTY (CI/скрипты/закрытый stdin) — прежнее
 * поведение: шаблон по умолчанию (uuid PK + name), stdin не читается.
 */
export async function runEntityCreateCommand(
  name: string,
  options: EntityCreateCommandOptions,
): Promise<CreatedFile> {
  const dir = options.dir;
  const output = options.output ?? process.stdout;

  // Коллизия обнаруживается ДО любых вопросов: файл никогда не перезаписывается.
  const target = entityFilePath(dir, name);
  if (fs.existsSync(target)) {
    throw new Error(
      `File already exists: ${target} — entity:create never overwrites files`,
    );
  }

  const input = options.input ?? process.stdin;
  const interactive =
    options.interactive ?? Boolean((input as NodeJS.ReadStream).isTTY);

  if (!interactive) {
    // Детерминированный неинтерактивный путь: stdin не читается вообще.
    return createDefaultEntity(name, dir, target, output);
  }

  try {
    return await runEntityCreateWizard(name, {
      name,
      dir,
      target,
      input,
      output,
    });
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      output.write(
        `entity:create cancelled (${err.message}) — nothing written\n`,
      );
      process.exitCode = 130;
      throw err;
    }
    throw err;
  }
}

function createDefaultEntity(
  name: string,
  dir: string,
  target: string,
  output: Writable,
): CreatedFile {
  const spec = buildDefaultEntitySpec(name);
  const created = createEntityFileFromSpec(dir, spec, { filePath: target });
  output.write(`Entity created: ${created.filePath}\n`);
  return created;
}

export interface EntityCreateWizardOptions extends PromptIo {
  name: string;
  dir: string;
  /** Целевой путь файла (по умолчанию выводится из имени). */
  target?: string;
}

/**
 * Запускает интерактивный мастер и пишет файл сущности.
 * Бросает PromptCancelledError при EOF/Ctrl+C/Ctrl+D — файл в этом случае
 * гарантированно не создаётся.
 */
export async function runEntityCreateWizard(
  name: string,
  options: EntityCreateWizardOptions,
): Promise<CreatedFile> {
  const io = new PromptReader(options);
  const target = options.target ?? entityFilePath(options.dir, name);

  try {
    io.writeLine(`Creating entity ${buildDefaultEntitySpec(name).className}`);
    io.writeLine('(empty column name finishes; Ctrl+C cancels)');

    // Имя таблицы: пустой ввод принимает дефолт; невалидное переспрашивается.
    const tableName = await askTableName(io, toSnakeCase(name));

    const columns: YdbEntityColumnSpec[] = [];
    let firstColumn = true;

    for (;;) {
      const columnName = await io.ask('column name (empty to finish): ');
      if (columnName === '') break;

      const invalid = columnNameIssue(columnName, columns);
      if (invalid) {
        io.writeLine(`  ! ${invalid}`);
        continue;
      }

      const primary = await io.confirm(
        `make "${columnName}" a primary key?`,
        firstColumn,
      );
      const type = await askColumnType(io, primary);

      const column: YdbEntityColumnSpec = { name: columnName, type };
      if (primary) {
        column.primary = true;
        columns.push(column);
        firstColumn = false;
        if (!(await io.confirm('add another column?', true))) break;
        continue;
      }
      firstColumn = false;

      if (await io.confirm('encrypt this field (@YdbEncrypted)?', false)) {
        column.encrypted = true;
        column.blindIndex = await io.confirm('add blind index?', true);
      } else if (type === 'Utf8' || type === 'Int32') {
        // Enum имеет смысл только для строковых и целочисленных колонок.
        if (await askEnum(io, column)) continue;
        await askDateColumns(io, column, type);
      } else {
        await askDateColumns(io, column, type);
      }
      columns.push(column);

      if (!columns.some((c) => c.primary)) {
        io.writeLine('  ! entity needs at least one primary key');
        continue;
      }
      if (!(await io.confirm('add another column?', true))) break;
    }

    if (columns.length === 0 || !columns.some((c) => c.primary)) {
      throw new Error(
        'entity requires at least one primary key column — nothing written',
      );
    }

    // TTL предлагается только для date-like колонок (unit не требуется).
    const dateLikeColumns = columns.filter((c) => DATE_LIKE_TYPES.has(c.type));
    let ttl: YdbEntitySpec['ttl'];
    if (dateLikeColumns.length > 0) {
      const interval = await io.ask(
        'TTL interval (ISO 8601, e.g. PT2H; empty skips): ',
      );
      if (interval !== '') {
        ttl = {
          interval,
          column:
            dateLikeColumns.length > 1
              ? await askTtlColumn(io, dateLikeColumns)
              : dateLikeColumns[0].name,
        };
      }
    }

    const spec: YdbEntitySpec = {
      className: buildDefaultEntitySpec(name).className,
      tableName,
      columns,
      ttl: ttl ?? null,
    };

    // Полная валидация введённых определений ДО записи файла (#24).
    const issues = validateEntitySpec(spec);
    if (issues.length) {
      for (const issue of issues) io.writeLine(`  ! ${issue}`);
      throw new Error('entity definition is invalid — nothing written');
    }

    const preview = renderEntityFile(spec);
    io.writeLine('');
    io.writeLine(preview);
    if (!(await io.confirm(`write ${target}?`, true))) {
      throw new PromptCancelledError('declined by user');
    }

    return createEntityFileFromSpec(options.dir, spec, { filePath: target });
  } finally {
    io.close();
  }
}

/** Проблема имени колонки или null, если имя допустимо. */
function columnNameIssue(
  name: string,
  existing: YdbEntityColumnSpec[],
): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return (
      `"${name}" is not a valid property/column name ` +
      '(use letters, digits, underscore; do not start with a digit)'
    );
  }
  if (existing.some((c) => c.name === name)) {
    return `column "${name}" already exists`;
  }
  return null;
}

/** Для date-like колонок предлагает автопростановку create/update времени. */
async function askDateColumns(
  io: PromptReader,
  column: YdbEntityColumnSpec,
  type: YdbPrimitive,
): Promise<void> {
  if (!DATE_LIKE_TYPES.has(type)) return;
  if (
    await io.confirm('auto creation timestamp (@YdbCreateDateColumn)?', false)
  ) {
    column.createDate = true;
  }
  if (
    await io.confirm('auto update timestamp (@YdbUpdateDateColumn)?', false)
  ) {
    column.updateDate = true;
  }
}

async function askTableName(
  io: PromptReader,
  defaultValue: string,
): Promise<string> {
  for (;;) {
    const answer = await io.ask(`table name (${defaultValue}): `);
    const candidate = answer === '' ? defaultValue : answer;
    try {
      validateTableName(candidate);
      return candidate;
    } catch {
      io.writeLine(
        `  ! invalid table name "${candidate}" — must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
      );
    }
  }
}

async function askColumnType(
  io: PromptReader,
  primary: boolean,
): Promise<YdbPrimitive> {
  const fallback = primary ? 'Uuid' : 'Utf8';
  for (;;) {
    const answer = await io.ask(
      `YDB type [${fallback}] (${ENTITY_CREATE_TYPES.join(', ')}): `,
    );
    const candidate = answer === '' ? fallback : answer;
    const match = ENTITY_CREATE_TYPES.find(
      (t) => t.toLowerCase() === candidate.toLowerCase(),
    );
    if (match) return match;
    io.writeLine(`  ! unknown type "${candidate}"`);
  }
}

/**
 * Спрашивает enum-опции для колонки. Возвращает true, если ввод невалиден
 * и модификаторы колонки нужно выбрать заново.
 */
async function askEnum(
  io: PromptReader,
  column: YdbEntityColumnSpec,
): Promise<boolean> {
  if (!(await io.confirm('enum column (@YdbEnum)?', false))) return false;

  const raw = await io.ask('enum values (comma-separated): ');
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (values.length === 0) {
    io.writeLine('  ! at least one enum value is required');
    return true;
  }
  const members = values.map(toEnumMemberName);
  const badMember = members.findIndex(
    (m) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(m),
  );
  if (badMember >= 0) {
    io.writeLine(
      `  ! cannot derive enum member name from "${values[badMember]}"`,
    );
    return true;
  }
  if (new Set(members).size !== members.length) {
    io.writeLine('  ! enum member names collide');
    return true;
  }

  const storageAnswer = await io.ask('enum storage [Utf8] (Utf8|Int32): ');
  const normalized = storageAnswer.trim().toLowerCase();
  if (normalized !== '' && normalized !== 'utf8' && normalized !== 'int32') {
    io.writeLine('  ! storage must be Utf8 or Int32');
    return true;
  }

  column.enumValues = values;
  column.enumStorage = normalized === 'int32' ? 'Int32' : 'Utf8';
  return false;
}

async function askTtlColumn(
  io: PromptReader,
  candidates: YdbEntityColumnSpec[],
): Promise<string> {
  const names = candidates.map((c) => c.name).join(', ');
  for (;;) {
    const answer = await io.ask(`TTL column (${names}): `);
    const match = candidates.find((c) => c.name === answer.trim());
    if (match) return match.name;
    io.writeLine(`  ! choose one of: ${names}`);
  }
}
