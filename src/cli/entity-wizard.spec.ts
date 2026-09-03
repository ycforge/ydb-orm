import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { PromptReader, PromptCancelledError } from './prompt.js';
import {
  runEntityCreateCommand,
  runEntityCreateWizard,
} from './entity-wizard.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-orm-wizard-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface ScriptedIo {
  input: PassThrough;
  output: PassThrough;
  text: () => string;
}

/** Pipe with scripted answers: lines fed by \n, then EOF. */
function scripted(answers: string[]): ScriptedIo {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = '';
  output.on('data', (chunk) => {
    captured += chunk;
  });
  if (answers.length > 0) {
    input.end(`${answers.join('\n')}\n`);
  } else {
    input.end();
  }
  return { input, output, text: () => captured };
}

const expectWizardSuccess = async (
  answers: string[],
  name = 'test thing',
): Promise<string> => {
  const io = scripted(answers);
  const created = await runEntityCreateCommand(name, {
    dir,
    interactive: true,
    ...io,
  });
  expect(fs.existsSync(created.filePath)).toBe(true);
  return fs.readFileSync(created.filePath, 'utf-8');
};

describe('runEntityCreateWizard (#24)', () => {
  it('creates a minimal entity: uuid PK accepted by defaults only', async () => {
    // table='' (default), uuid, pk=Y, type=Uuid, another=n, write=Y
    const content = await expectWizardSuccess(['', 'uuid', '', '', 'n', '']);
    expect(content).toContain(`@YdbEntity('test_thing')`);
    expect(content).toContain(`@YdbPrimaryColumn('Uuid')`);
    expect(content).toContain('uuid: string;');
    expect(content).not.toContain('@YdbColumn');
  });

  it('creates an entity with a custom PK name and type', async () => {
    // id, pk=Y(default n -> y), type=Int64, another=n, write
    const content = await expectWizardSuccess([
      'accounts',
      'id',
      'y',
      'Int64',
      'n',
      '',
    ]);
    expect(content).toContain(`export class TestThing extends YdbBaseEntity`);
    expect(content).toContain(`@YdbPrimaryColumn('Int64')`);
    expect(content).toContain('id: bigint;');
  });

  it('adds create/update timestamp columns when selected', async () => {
    // uuid pk | created_at Timestamp createDate=Y | updated_at Datetime updateDate=Y
    // (enum question only asked for Utf8/Int32 — Timestamp has none)
    const content = await expectWizardSuccess([
      '', // default table
      'uuid',
      '', // pk? Y
      '', // type Uuid
      '', // add another? yes
      'created_at',
      'n', // pk
      'Timestamp',
      'n', // encrypted?
      'y', // createDate
      'n', // updateDate
      '', // add another? yes
      'updated_at',
      'n', // pk
      'Datetime',
      'n', // encrypted?
      'n', // createDate
      'y', // updateDate
      'n', // add another? no
      '', // TTL? skip (has date-like columns)
      '', // write
    ]);
    expect(content).toContain(`@YdbCreateDateColumn()`);
    expect(content).toContain(`@YdbUpdateDateColumn()`);
    expect(content).toMatch(
      /@YdbCreateDateColumn\(\)\n\s+@YdbColumn\('Timestamp'\)\n\s+created_at: Date;/,
    );
    expect(content).toMatch(
      /@YdbUpdateDateColumn\(\)\n\s+@YdbColumn\('Datetime'\)\n\s+updated_at: Date;/,
    );
  });

  it('offers TTL for date-like columns and renders @YdbTtl', async () => {
    const content = await expectWizardSuccess([
      '',
      'uuid',
      '', // pk Y
      '', // type Uuid
      '', // another yes
      'expires_at',
      'n', // pk
      'Timestamp',
      'n', // encrypted
      'n', // createDate
      'n', // updateDate
      'n', // another no
      'PT2H', // TTL interval
      '', // write
    ]);
    expect(content).toContain(
      `@YdbTtl({ interval: 'PT2H', column: 'expires_at' })`,
    );
  });

  it('re-prompts on invalid column names, duplicates and unknown types', async () => {
    // bad-name -> error -> duplicate uuid -> error -> valid name; unknown type -> Utf8
    const content = await expectWizardSuccess([
      '',
      'uuid', // first column (PK by default)
      '', // pk Y
      '', // type Uuid
      '', // add another? yes
      'bad-name', // invalid
      'uuid', // duplicate
      'title',
      'n', // pk
      'NotAType', // unknown type
      '', // Utf8
      'n', // encrypted
      'y', // enum?
      'draft,published', // values
      '', // storage Utf8
      'n', // add another? no
      '', // write
    ]);
    expect(content).toContain(`@YdbEntity('test_thing')`);
    expect(content).toContain(`@YdbPrimaryColumn('Uuid')`);
    // enum branch also worked: the column got @YdbEnum on top of Utf8
    expect(content).toContain(`@YdbColumn('Utf8')`);
    expect(content).toContain(`title: TitleEnum;`);
    expect(content).toContain("DRAFT = 'draft',");
    expect(content.match(/title:/g)).toHaveLength(1);
  });

  it('rejects a table name until it is valid', async () => {
    const io = scripted(['bad-table', 'also bad', '', 'uuid', '', '', 'n', '']);
    const created = await runEntityCreateCommand('orders', {
      dir,
      interactive: true,
      ...io,
    });
    const content = fs.readFileSync(created.filePath, 'utf-8');
    expect(content).toContain(`@YdbEntity('orders')`);
    expect(io.text()).toContain('invalid table name "bad-table"');
  });

  it('writes nothing when the final confirmation is declined', async () => {
    const io = scripted(['', 'uuid', '', '', 'n', 'n']);
    await expect(
      runEntityCreateCommand('declined', { dir, interactive: true, ...io }),
    ).rejects.toBeInstanceOf(PromptCancelledError);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});

describe('cancellation/EOF (#24)', () => {
  it('aborts cleanly on EOF in the middle of the flow — no file written', async () => {
    const io = scripted(['']); // only table name, then input ended
    await expect(
      runEntityCreateCommand('aborted', { dir, interactive: true, ...io }),
    ).rejects.toBeInstanceOf(PromptCancelledError);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('aborts immediately on empty stdin (EOF before the first question)', async () => {
    const io = scripted([]);
    await expect(
      runEntityCreateCommand('aborted2', { dir, interactive: true, ...io }),
    ).rejects.toBeInstanceOf(PromptCancelledError);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('PromptReader.cancel rejects the pending question idempotently', async () => {
    const input = new PassThrough();
    const reader = new PromptReader({
      input,
      output: new PassThrough(),
    });
    const first = reader.ask('one: ');
    const err = new PromptCancelledError('SIGINT (Ctrl+C)');
    reader.cancel(err);
    reader.cancel(new Error('second')); // idempotent
    await expect(first).rejects.toBe(err);
    await expect(reader.ask('two: ')).rejects.toBe(err);
    input.end();
  });
});

describe('non-TTY behavior (#24)', () => {
  it('does not read stdin outside TTY: deterministic default template', async () => {
    // Input stream never ends: if command tries to read stdin, test would
    // hang and fail by jest timeout.
    const input = new PassThrough(); // no data, no end()
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => {
      out += String(d);
    });

    const created = await runEntityCreateCommand('Product Card', {
      dir,
      input,
      output,
      interactive: false,
    });

    expect(created.name).toBe('ProductCard');
    const content = fs.readFileSync(created.filePath, 'utf-8');
    expect(content).toContain(`@YdbEntity('product_card')`);
    expect(content).toContain(`@YdbPrimaryColumn('Uuid')`);
    expect(out).toBe(`Entity created: ${created.filePath}\n`);
  });

  it('detects non-TTY automatically when isTTY is absent', async () => {
    const input = new PassThrough();
    const created = await runEntityCreateCommand('plain', {
      dir,
      input,
      output: new PassThrough(),
    });
    expect(fs.existsSync(created.filePath)).toBe(true);
  });
});

describe('collision handling (#24)', () => {
  it('fails before any question when the target file exists', async () => {
    const existing = path.join(dir, 'taken.entity.ts');
    fs.writeFileSync(existing, '// precious\n', 'utf-8');

    // interactive:false — collision checked even before wizard.
    await expect(
      runEntityCreateCommand('taken', { dir, interactive: false }),
    ).rejects.toThrow(/already exists.*never overwrites/s);

    // Input not consumed and file not modified.
    expect(fs.readFileSync(existing, 'utf-8')).toBe('// precious\n');
  });

  it('wizard-level collision check fires even with forced interactive mode', async () => {
    const existing = path.join(dir, 'clash.entity.ts');
    fs.writeFileSync(existing, '// keep\n', 'utf-8');
    const io = scripted([]);
    await expect(
      runEntityCreateCommand('clash', { dir, interactive: true, ...io }),
    ).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(existing, 'utf-8')).toBe('// keep\n');
  });
});

describe('runEntityCreateWizard (direct)', () => {
  it('honors explicit target path option', async () => {
    const io = scripted(['custom_table', 'id', 'y', 'Int32', 'n', '']);
    const created = await runEntityCreateWizard('widget', {
      name: 'widget',
      dir,
      target: path.join(dir, 'overridden.entity.ts'),
      ...io,
    });
    expect(created.filePath).toBe(path.join(dir, 'overridden.entity.ts'));
    const content = fs.readFileSync(created.filePath, 'utf-8');
    expect(content).toContain(`@YdbEntity('custom_table')`);
    expect(content).toContain(`@YdbPrimaryColumn('Int32')`);
  });
});
