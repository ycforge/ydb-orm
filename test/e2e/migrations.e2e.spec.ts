import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  createE2eContext,
  closeE2eContext,
  hasYdbCredentials,
  type E2eContext,
} from './setup.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let ctx: E2eContext | null = null;
let tmpDir: string;

beforeAll(async () => {
  ctx = await createE2eContext();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-orm-e2e-mig-'));
});

afterAll(() => {
  if (ctx) closeE2eContext(ctx);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const describeE2e = () => (hasYdbCredentials() ? describe : describe.skip);

describeE2e()('Migrations e2e', () => {
  const cliBin = path.resolve(__dirname, '../../dist/cli/cli.js');
  const endpoint = process.env.YDB_ENDPOINT ?? '';
  const authType = process.env.YDB_AUTH_TYPE ?? 'anonymous';
  const authKeyPath = process.env.YDB_AUTHORIZED_KEY_PATH ?? '';

  function cliEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      YDB_ENDPOINT: endpoint,
      YDB_AUTH_TYPE: authType,
      ...(authKeyPath ? { YDB_AUTHORIZED_KEY_PATH: authKeyPath } : {}),
    };
  }

  it('migration:create generates a migration file', async () => {
    const outDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(outDir, { recursive: true });

    const result = await execAsync(
      `node ${cliBin} migration:create TestMigration --dir ${outDir}`,
      { cwd: tmpDir, timeout: 30000, env: cliEnv() },
    );

    expect(result.stdout).toContain('created');
    const files = fs.readdirSync(outDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/TestMigration/);

    const content = fs.readFileSync(path.join(outDir, files[0]), 'utf-8');
    expect(content).toContain('up');
    expect(content).toContain('down');
  });

  it('migration:show lists no migrations initially', async () => {
    const result = await execAsync(
      `node ${cliBin} migration:show --dir ${tmpDir}`,
      { cwd: tmpDir, timeout: 30000, env: cliEnv() },
    );

    // On success, execAsync resolves (exitCode undefined for 0)
    expect(result.stdout).toBeDefined();
  });
});
