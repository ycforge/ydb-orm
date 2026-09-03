import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { YdbMigration } from './migration.interface.js';

const MIGRATION_FILE_RE = /\.(ts|mts|js|mjs)$/;

/** Declaration files and source maps contain no executable migration code. */
const NON_CODE_FILE_RE = /(?:\.d\.ts|\.map)$/;

/**
 * Test files are never migrations (#100): a stray `*.spec.ts`/`*.test.ts`
 * must not break migration:run/show/check.
 */
const TEST_FILE_RE = /\.(spec|test)\.[^./]+$/;

function isMigrationFileName(file: string): boolean {
  if (!MIGRATION_FILE_RE.test(file)) return false;
  if (NON_CODE_FILE_RE.test(file)) return false;
  if (TEST_FILE_RE.test(file)) return false;
  return true;
}

/** Checks whether a value looks like a migration: a class or object with up/down. */
function isMigrationLike(candidate: unknown): boolean {
  if (typeof candidate === 'function') {
    const proto = (candidate as { prototype?: unknown }).prototype as
      Record<string, unknown> | null | undefined;
    return Boolean(
      proto &&
      typeof proto.up === 'function' &&
      typeof proto.down === 'function',
    );
  }
  if (candidate && typeof candidate === 'object') {
    const obj = candidate as Record<string, unknown>;
    return typeof obj.up === 'function' && typeof obj.down === 'function';
  }
  return false;
}

interface MigrationCandidate {
  /** Names of the exports pointing at this class/object (for error messages). */
  names: string[];
  create: () => YdbMigration;
}

/**
 * Collects all migration-like exports of a module.
 * A `default` export and a named export of the same class are a single
 * candidate (deduplicated by value).
 */
function collectCandidates(mod: Record<string, any>): MigrationCandidate[] {
  const byValue = new Map<unknown, MigrationCandidate>();
  for (const [exportName, value] of Object.entries(mod)) {
    if (!isMigrationLike(value)) continue;

    let entry = byValue.get(value);
    if (!entry) {
      entry = {
        names: [],
        create: () =>
          typeof value === 'function'
            ? new (value as new () => YdbMigration)()
            : (value as YdbMigration),
      };
      byValue.set(value, entry);
    }
    entry.names.push(exportName);
  }
  return [...byValue.values()];
}

/**
 * Loads migrations from a directory: every `.ts`/`.js`/`.mts`/`.mjs` file
 * must export exactly one migration (default or named).
 * Test (`*.spec.*`, `*.test.*`) and declaration files are ignored (#100).
 * Node >= 22.18 imports .ts directly (type stripping).
 *
 * The migration name is the file name without the extension
 * (`<timestamp>-<Name>`); ordering is by file name. Files with the same
 * migration name (e.g., a `.ts` source next to its compiled `.js` copy)
 * produce an error rather than a silent skip.
 *
 * Each migration gets a stable identity (#101): SHA-256 of the file content
 * (`migration.hash`). Renaming the file does not change the identity, so an
 * applied migration is not run again.
 */
export async function loadMigrationsFromDir(
  dir: string,
): Promise<YdbMigration[]> {
  // A nonexistent directory is an error, not "No pending migrations" (#103):
  // a typo in --dir must not look like an absence of migrations.
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Migration directory does not exist: ${path.resolve(dir)} ` +
        `(resolved from "${dir}"). Create it with ` +
        `"ydb-orm migration:create <name>" or pass a correct --dir.`,
    );
  }
  if (!fs.statSync(dir).isDirectory()) {
    throw new Error(
      `Migration directory is not a directory: ${path.resolve(dir)} ` +
        `(resolved from "${dir}").`,
    );
  }

  const files = fs.readdirSync(dir).filter(isMigrationFileName).sort();

  const migrations: YdbMigration[] = [];
  const fileByName = new Map<string, string>();
  const fileByHash = new Map<string, string>();

  for (const file of files) {
    const filePath = path.join(dir, file);
    const contentHash = createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex');

    // Two files with identical content are almost certainly copies (#101):
    // both would apply "successfully", but the second would fail on
    // already-executed DDL. Previously this surfaced only at DB runtime.
    const duplicateHashFile = fileByHash.get(contentHash);
    if (duplicateHashFile) {
      throw new Error(
        `Files ${duplicateHashFile} and ${file} have identical content ` +
          `(hash "${contentHash}"). Keep exactly one of them.`,
      );
    }
    fileByHash.set(contentHash, file);

    const mod = (await import(pathToFileURL(filePath).href)) as Record<
      string,
      any
    >;

    const candidates = collectCandidates(mod);
    if (candidates.length === 0) {
      throw new Error(
        `File ${file} does not export a migration class ` +
          `(expected default or named export of a class or object with up()/down() methods)`,
      );
    }
    // Several migrations in one file are ambiguous (#100): previously the first
    // matching export was silently taken.
    if (candidates.length > 1) {
      const names = candidates
        .flatMap((c) => c.names)
        .sort()
        .join(', ');
      throw new Error(
        `File ${file} exports multiple migration implementations (${names}). ` +
          `Keep exactly one migration export per file.`,
      );
    }

    const migration = candidates[0].create();
    migration.name ??= file.replace(MIGRATION_FILE_RE, '');
    // Stable identity (#101): the hash always comes from the file content. A
    // hash declared in the migration code can neither override it (it is never
    // used as the identity — always overwritten with contentHash), nor vouch
    // for the content: in a real file the declared hash is part of its own
    // content, so it cannot match contentHash in principle, and a mismatch is
    // a sign of forgery/an outdated template (#169). A match (theoretically
    // possible if the hashed content ever stops including the declaration
    // literal) is accepted without harm to security — the identity is
    // content-based anyway.
    if (migration.hash !== undefined && migration.hash !== contentHash) {
      throw new Error(
        `File ${file} declares its own migration hash ("${migration.hash}") ` +
          `which differs from the file content hash. Migration identity is ` +
          `derived from the file content (#169) — remove the "hash" property. ` +
          `If this migration was already applied under the declared hash, resolve ` +
          `the bookkeeping row explicitly via removeMigrationRecord()/markMigrationApplied() ` +
          `(see README "Обновление с версий до content-based identity").`,
      );
    }
    migration.hash = contentHash;

    // Duplicate names (incl. `.ts` + a compiled `.js` next to it) — previously
    // the second file was silently skipped or applied twice in the runner (#100).
    const duplicateFile = fileByName.get(migration.name);
    if (duplicateFile) {
      throw new Error(
        `Duplicate migration name "${migration.name}" from files ` +
          `${duplicateFile} and ${file}. Remove one of them — likely a compiled copy next to its source.`,
      );
    }
    fileByName.set(migration.name, file);

    migrations.push(migration);
  }

  return migrations;
}
