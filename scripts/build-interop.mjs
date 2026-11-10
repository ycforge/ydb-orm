import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist/cjs', { recursive: true });
// Async bridge shares the ESM module cache and does not rely on require(esm).
writeFileSync(
  'dist/cjs/index.cjs',
  `exports.load = () => import('../index.js');\nexports.loadNest = () => import('../nest/index.js');\n`,
);
writeFileSync(
  'dist/cjs/index.d.cts',
  `export declare function load(): Promise<typeof import('../index.js')>;\nexport declare function loadNest(): Promise<typeof import('../nest/index.js')>;\n`,
);
