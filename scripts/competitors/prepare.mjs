// Benchmark-only dependency workspace. Never adds competitors to the SDK.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const cache = resolve(root, '.cache/competitor-packages');
await mkdir(cache, { recursive: true });
for (const file of ['package.json', 'package-lock.json'])
  await copyFile(resolve(import.meta.dirname, file), resolve(cache, file));
if (process.argv.includes('--install'))
  execFileSync('npm', ['ci', '--ignore-scripts', '--prefix', cache], { stdio: 'inherit' });
for (const [name, version] of [
  ['ghostty-web', '0.4.0'],
  ['restty', '0.3.0'],
]) {
  const pkg = JSON.parse(await readFile(resolve(cache, 'node_modules', name, 'package.json')));
  assert.equal(pkg.version, version, 'Run prepare.mjs --install to install pinned dependencies');
}

// Use the exact existing Wraith/official-xterm adapters and workload generator,
// without executing the demo UI. Changes are listed in adapter-source.json.
const source = await readFile(resolve(root, 'demo/compare.js'), 'utf8');
const boundary = source.indexOf('\nlet active;');
assert(boundary > 0 && source.indexOf('\nlet active;', boundary + 1) < 0);
let adapter = source
  .slice(0, boundary)
  .replaceAll("'../packages/", "'/packages/")
  .replace("'./showcase.js'", "'/demo/showcase.js'")
  .replace("'./pipes-scene.js'", "'/demo/pipes-scene.js'")
  .replace(
    "new URL('./fonts/JetBrainsMono-Regular.ttf', import.meta.url)",
    "'/demo/fonts/JetBrainsMono-Regular.ttf'",
  );
assert.equal((adapter.match(/2000/g) ?? []).length, 2);
adapter = adapter.replaceAll('2000', '0');
assert.equal((adapter.match(/new WebglAddon\(\)/g) ?? []).length, 1);
adapter = adapter.replace(
  'new WebglAddon()',
  'new WebglAddon(Boolean(window.__wraithValidationCapture))',
);
adapter += '\nexport { mount, workload, font, glFence, visibleText, percentiles };\n';
await writeFile(resolve(cache, 'wraith-adapter.js'), adapter);
await writeFile(
  resolve(cache, 'adapter-source.json'),
  JSON.stringify(
    {
      source: 'demo/compare.js',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      generatedSha256: createHash('sha256').update(adapter).digest('hex'),
      changes: [
        'import/font URL paths',
        'disable scrollback for common viewport-only workload',
        'preserve WebGL drawing buffer only for untimed screenshot validation',
        'export adapters before UI startup',
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log('Prepared pinned competitor packages and current Wraith adapters.');
