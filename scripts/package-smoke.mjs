import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

execFileSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    '-p',
    'examples/serverless-nest/tsconfig.json',
  ],
  { stdio: 'inherit' },
);
// Keep npm dependencies external: no class-transformer/storage aliases or optional
// Nest transports are needed. Deploy node_modules alongside the resulting module.
await build({
  entryPoints: ['.tmp/serverless-nest/main.js'],
  outfile: '.tmp/serverless-nest/bundle.mjs',
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node22',
  format: 'esm',
});
await (
  await import(
    pathToFileURL(`${process.cwd()}/.tmp/serverless-nest/bundle.mjs`)
  )
).smoke();
mkdirSync('.tmp', { recursive: true });
writeFileSync(
  '.tmp/commonjs-smoke.cts',
  `
import { load, loadNest } from '@ycforge/ydb-orm/cjs';
async function check() {
  const orm = await load();
  orm.rawJson('{}');
  const nest = await loadNest();
  nest.YdbCoreModule.forRootAsync({ useFactory: () => ({ endpoint: 'unused' }) });
}
void check;
`,
);
execFileSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2023',
    '--skipLibCheck',
    '--rootDir',
    '.',
    '.tmp/commonjs-smoke.cts',
  ],
  { stdio: 'inherit' },
);
writeFileSync(
  '.tmp/commonjs-smoke.cjs',
  `
(async () => {
  const { load, loadNest } = require('@ycforge/ydb-orm/cjs');
  const orm = await load();
  const nest = await loadNest();
  if (orm !== await import('@ycforge/ydb-orm')) throw new Error('Duplicate ESM runtime');
  if (typeof orm.YdbSchemaSyncer !== 'function' || typeof nest.YdbCoreModule !== 'function') throw new Error('CJS interop failed');
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
);
execFileSync(process.execPath, ['.tmp/commonjs-smoke.cjs'], {
  stdio: 'inherit',
});
console.log('Nest tsc → esbuild and CommonJS → ESM smoke tests passed.');
