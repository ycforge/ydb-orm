import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import 'reflect-metadata';
import {
  buildDefaultEntitySpec,
  renderEntityFile,
  type YdbEntitySpec,
} from '../../src/cli/generators.js';
import { getYdbEntityMetadata } from '../../src/metadata/entity-metadata.js';
import { getYdbEnumMetadata } from '../../src/decorators/enum.decorator.js';
import { getYdbTtlMetadata } from '../../src/decorators/ttl.decorator.js';
import {
  YDB_CREATE_DATE_KEY,
  YDB_UPDATE_DATE_KEY,
} from '../../src/decorators/timestamp.decorator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Варианты спецификаций: покрывают минимальную сущность, UUID PK, кастомный
// PK, date/create/update колонки, enum (Utf8/Int32), encryption и TTL (#24).
// ---------------------------------------------------------------------------

const VARIANTS: Record<string, YdbEntitySpec> = {
  minimal: {
    className: 'ProductEntity',
    tableName: 'products',
    columns: [
      { name: 'uuid', type: 'Uuid', primary: true },
      { name: 'name', type: 'Utf8' },
    ],
  },
  uuidPk: {
    className: 'SessionEntity',
    tableName: 'sessions',
    columns: [
      { name: 'uuid', type: 'Uuid', primary: true },
      { name: 'token', type: 'Utf8' },
    ],
  },
  customPk: {
    className: 'AccountEntity',
    tableName: 'accounts',
    columns: [
      { name: 'account_id', type: 'Int64', primary: true },
      { name: 'balance', type: 'Double' },
    ],
  },
  compositePk: {
    className: 'MembershipEntity',
    tableName: 'memberships',
    columns: [
      { name: 'user_uuid', type: 'Uuid', primary: true },
      { name: 'role_id', type: 'Int32', primary: true },
    ],
  },
  dates: {
    className: 'AuditEntity',
    tableName: 'audit_logs',
    columns: [
      { name: 'uuid', type: 'Uuid', primary: true },
      { name: 'action', type: 'Utf8' },
      { name: 'happened_on', type: 'Date' },
      { name: 'logged_at', type: 'Datetime', createDate: true },
      { name: 'changed_at', type: 'Timestamp', updateDate: true },
    ],
  },
  enums: {
    className: 'OrderEntity',
    tableName: 'orders_wizard',
    columns: [
      { name: 'uuid', type: 'Uuid', primary: true },
      {
        name: 'status',
        type: 'Utf8',
        enumValues: ['active', 'new_order'],
        enumStorage: 'Utf8',
      },
      {
        name: 'state_code',
        type: 'Int32',
        enumValues: ['draft', 'sent'],
        enumStorage: 'Int32',
      },
    ],
  },
  // Нормализация имён членов lossy, но члены остаются уникальными:
  // пунктуация, регистр и цифровой префикс не должны ломать компиляцию (#153).
  enumNormalization: {
    className: 'WorkflowEntity',
    tableName: 'workflows_wizard',
    columns: [
      { name: 'uuid', type: 'Uuid', primary: true },
      {
        name: 'stage',
        type: 'Utf8',
        enumValues: ['draft-review', 'wip.draft', '2nd-class', 'v 1'],
      },
    ],
  },
  encryption: {
    className: 'SecretEntity',
    tableName: 'secrets_wizard',
    columns: [
      { name: 'uuid', type: 'Uuid', primary: true },
      { name: 'email', type: 'Utf8', encrypted: true, blindIndex: false },
      { name: 'ssn', type: 'Utf8', encrypted: true },
    ],
  },
  ttl: {
    className: 'CacheEntryEntity',
    tableName: 'cache_entries',
    columns: [
      { name: 'uuid', type: 'Uuid', primary: true },
      { name: 'payload', type: 'Json' },
      { name: 'expires_at', type: 'Timestamp' },
    ],
    ttl: { interval: 'PT2H', column: 'expires_at' },
  },
};

// ---------------------------------------------------------------------------
// Часть 1: сгенерированный код проходит type-check против РЕАЛЬНОГО
// публичного API (src/index.ts через маппинг '@ycforge/ydb-orm').
// ---------------------------------------------------------------------------

function typeCheckGenerated(
  files: Record<string, string>,
): readonly ts.Diagnostic[] {
  const options: ts.CompilerOptions = {
    strictNullChecks: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    skipLibCheck: true,
    esModuleInterop: true,
    noEmit: true,
  };
  const indexTs = path.join(REPO_ROOT, 'src', 'index.ts');

  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const virtualPaths = new Set(Object.keys(files));

  host.getSourceFile = (
    fileName: string,
    languageVersion: ts.ScriptTarget,
    onError?: (message: string) => void,
  ) => {
    const virtual = files[fileName];
    if (virtual !== undefined) {
      return ts.createSourceFile(fileName, virtual, languageVersion, true);
    }
    return originalGetSourceFile(fileName, languageVersion, onError);
  };

  host.resolveModuleNames = (
    moduleNames: readonly string[],
    containingFile: string,
  ): (ts.ResolvedModule | undefined)[] => {
    return moduleNames.map((moduleName) => {
      if (moduleName === '@ycforge/ydb-orm') {
        return { resolvedFileName: indexTs };
      }
      // NodeNext-резолв корректно маппит './x.js' → './x.ts' внутри src/.
      return ts.resolveModuleName(moduleName, containingFile, options, host)
        .resolvedModule;
    });
  };

  const program = ts.createProgram({
    rootNames: [...virtualPaths],
    options,
    host,
  });
  return ts.getPreEmitDiagnostics(program);
}

describe('entity:create — сгенерированный код соответствует API (#24)', () => {
  it('все варианты проходят type-check против текущего src/index.ts', () => {
    const files: Record<string, string> = {};
    for (const [name, spec] of Object.entries(VARIANTS)) {
      files[path.join(REPO_ROOT, '.tmp-entity-check', `${name}.entity.ts`)] =
        renderEntityFile(spec);
    }

    const diagnostics = typeCheckGenerated(files);
    const formatted = diagnostics
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    expect(formatted).toBe('');
  });

  it('дефолтный шаблон (неинтерактивный путь) тоже компилируется', () => {
    const diagnostics = typeCheckGenerated({
      [path.join(REPO_ROOT, '.tmp-entity-check', 'default.entity.ts')]:
        renderEntityFile(buildDefaultEntitySpec('default thing')),
    });
    expect(diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Часть 2: рантайм-проверка метаданных — файл пишется внутрь репозитория и
// импортируется через ts-jest (та же трансформация, что у тестов), декораторы
// применяются реальными имплементациями библиотеки.
// ---------------------------------------------------------------------------

let runtimeDir: string;
let runtimeDirCreated = false;

async function loadGeneratedModule(
  variant: string,
): Promise<Record<string, any>> {
  const spec = VARIANTS[variant];
  const rendered = renderEntityFile(spec).replace(
    "'@ycforge/ydb-orm'",
    `'../src/index.js'`,
  );
  if (!runtimeDirCreated) {
    runtimeDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-entity-runtime-'));
    runtimeDirCreated = true;
  }
  const filePath = path.join(runtimeDir, `${variant}.entity.ts`);
  fs.writeFileSync(filePath, rendered, 'utf-8');
  return (await import(pathToFileURL(filePath).href)) as Record<string, any>;
}

describe('entity:create — рантайм-метаданные сгенерированных сущностей (#24)', () => {
  afterEach(() => {
    if (runtimeDirCreated) {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      runtimeDirCreated = false;
    }
  });

  it('минимальная сущность: таблица, PK, типы колонок', async () => {
    const mod = await loadGeneratedModule('minimal');
    const meta = getYdbEntityMetadata(mod.ProductEntity);
    expect(meta?.tableName).toBe('products');
    expect(meta?.primaryKeys).toEqual(['uuid']);
    expect(meta?.schema).toEqual({ uuid: 'Uuid', name: 'Utf8' });
  });

  it('UUID PK объявлен через @YdbPrimaryColumn', async () => {
    const mod = await loadGeneratedModule('uuidPk');
    const meta = getYdbEntityMetadata(mod.SessionEntity);
    expect(meta?.primaryKeys).toEqual(['uuid']);
    expect(meta?.schema.uuid).toBe('Uuid');
  });

  it('кастомное имя и тип PK; составной PK сохраняет порядок', async () => {
    const account = getYdbEntityMetadata(
      (await loadGeneratedModule('customPk')).AccountEntity,
    );
    expect(account?.primaryKeys).toEqual(['account_id']);
    expect(account?.schema.account_id).toBe('Int64');

    const membership = getYdbEntityMetadata(
      (await loadGeneratedModule('compositePk')).MembershipEntity,
    );
    expect(membership?.primaryKeys).toEqual(['user_uuid', 'role_id']);
  });

  it('create/update date-колонки попадают в метаданные автопростановки', async () => {
    const mod = await loadGeneratedModule('dates');
    const Ctor = mod.AuditEntity;
    expect(getYdbEntityMetadata(Ctor)?.schema.logged_at).toBe('Datetime');
    expect(getYdbEntityMetadata(Ctor)?.schema.changed_at).toBe('Timestamp');
    expect(Reflect.getOwnMetadata(YDB_CREATE_DATE_KEY, Ctor)).toBe('logged_at');
    expect(Reflect.getOwnMetadata(YDB_UPDATE_DATE_KEY, Ctor)).toBe(
      'changed_at',
    );
  });

  it('enum: значения и storage для Utf8 и Int32', async () => {
    const mod = await loadGeneratedModule('enums');
    const Ctor = mod.OrderEntity;
    const enums = getYdbEnumMetadata(Ctor);

    const status = enums.find((e: any) => e.propertyKey === 'status');
    expect(status?.values).toEqual(['active', 'new_order']);
    expect(status?.storage).toBe('Utf8');

    const stateCode = enums.find((e: any) => e.propertyKey === 'state_code');
    expect(stateCode?.values).toEqual(['draft', 'sent']);
    expect(stateCode?.storage).toBe('Int32');
  });

  it('шифрование: Bytes в схеме, blindIndex из опций', async () => {
    const mod = await loadGeneratedModule('encryption');
    const meta = getYdbEntityMetadata(mod.SecretEntity);
    expect(meta?.schema.email).toBe('Bytes');
    expect(meta?.schema.ssn).toBe('Bytes');
    const email = meta?.encryptedFields.find((f) => f.propertyKey === 'email');
    expect(email?.blindIndex).toBe(false);
    const ssn = meta?.encryptedFields.find((f) => f.propertyKey === 'ssn');
    expect(ssn?.blindIndex).toBe(true);
  });

  it('TTL попадает в метаданные класса', async () => {
    const mod = await loadGeneratedModule('ttl');
    expect(getYdbTtlMetadata(mod.CacheEntryEntity)).toEqual({
      interval: 'PT2H',
      column: 'expires_at',
    });
  });
});

// ---------------------------------------------------------------------------
// Часть 3: процессный уровень — CLI вне TTY детерминирован и не ждёт ввода.
// Выполняется только если пакет собран (dist/ есть после `yarn build`).
// ---------------------------------------------------------------------------

const cliBin = path.join(REPO_ROOT, 'dist', 'cli', 'cli.js');
const describeCliBin = fs.existsSync(cliBin) ? describe : describe.skip;

describeCliBin('entity:create через бинарь вне TTY (#24)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-orm-entity-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCli(args: string[]): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliBin, ...args], {
        cwd: tmpDir,
        // stdin — труба без данных и без end(): если команда решит читать
        // ввод вне TTY, тест зависнет и упадёт по таймауту.
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`CLI hung waiting for input: ${stderr || stdout}`));
      }, 15000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  it('создаёт шаблон по умолчанию, не читая stdin (stdin остаётся открытым)', async () => {
    const outDir = path.join(tmpDir, 'entities');
    const result = await runCli([
      'entity:create',
      'Spawned Thing',
      '--dir',
      outDir,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Entity created:');
    const files = fs.readdirSync(outDir);
    expect(files).toEqual(['spawned-thing.entity.ts']);
    const content = fs.readFileSync(path.join(outDir, files[0]), 'utf-8');
    expect(content).toContain(`@YdbEntity('spawned_thing')`);
    expect(content).toContain(`@YdbPrimaryColumn('Uuid')`);
  });

  it('отказывается перезаписывать существующий файл (exit != 0)', async () => {
    const outDir = path.join(tmpDir, 'entities');
    fs.mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, 'taken.entity.ts');
    fs.writeFileSync(target, '// untouched\n', 'utf-8');

    const result = await runCli(['entity:create', 'taken', '--dir', outDir]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/already exists/);
    expect(fs.readFileSync(target, 'utf-8')).toBe('// untouched\n');
  });
});
