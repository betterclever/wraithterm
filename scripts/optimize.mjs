import { spawnSync } from 'node:child_process';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(process.env.WRAITH_BUILD_DIR ?? join(root, '.cache'));
await mkdir(build, { recursive: true });
const binary = join(root, 'packages/wraith/wasm/wraith_engine_bg.wasm'),
  out = join(build, 'wraith-optimized.wasm');
const version = spawnSync('wasm-opt', ['--version'], { encoding: 'utf8' });
if (version.status !== 0)
  throw new Error('Install Binaryen (wasm-opt) to run optional post-link optimization');
const before = (await stat(binary)).size;
const result = spawnSync(
  'wasm-opt',
  [
    '-O3',
    '--strip-dwarf',
    '--enable-simd',
    '--enable-bulk-memory',
    '--enable-sign-ext',
    '--enable-nontrapping-float-to-int',
    '--enable-multivalue',
    '--enable-reference-types',
    binary,
    '-o',
    out,
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0)
  throw new Error('Wasm optimization failed; original binary remains intact');
const after = (await stat(out)).size;
await rename(out, binary);
await writeFile(
  join(root, 'packages/wraith/wasm/optimization.json'),
  JSON.stringify(
    {
      optimizer: version.stdout.trim(),
      flags: '-O3 --strip-dwarf',
      beforeBytes: before,
      afterBytes: after,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Wasm optimized: ${before.toLocaleString()} → ${after.toLocaleString()} bytes`);
