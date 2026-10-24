import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem, platform, release, loadavg } from 'node:os';
import './prepare.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, process.env.WRAITH_REPORT_DIR ?? '.cache/competitor-comparison');
const probe = process.argv.includes('--probe');
const frames = Number(process.env.WRAITH_FRAMES ?? (probe ? 32 : 256));
const warmup = Number(process.env.WRAITH_WARMUP ?? (probe ? 8 : 64));
const repetitions = Number(process.env.WRAITH_REPETITIONS ?? (probe ? 1 : 3));
const targets = (process.env.WRAITH_TARGETS ?? 'wraith,ghostty,restty,ghostty-web,webgl').split(
  ',',
);
const conditions = (
  process.env.WRAITH_WORKLOADS ?? (probe ? 'complex' : 'complex,churn,append,showcase,pipes')
)
  .split(',')
  .map((workload) => ({ workload, dpr: 1 }));
if (!probe && process.env.WRAITH_RETINA !== '0') conditions.push({ workload: 'complex', dpr: 2 });
assert(Number.isInteger(frames) && frames >= 32 && frames <= 4096 && frames % 8 === 0);
assert(Number.isInteger(warmup) && warmup >= 8 && warmup <= 4096 && warmup % 8 === 0);
assert(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 20);
assert(targets.length && new Set(targets).size === targets.length);
assert(
  targets.every((target) =>
    ['wraith', 'ghostty', 'restty', 'ghostty-web', 'webgl'].includes(target),
  ),
);
assert(
  conditions.every(({ workload }) =>
    ['complex', 'churn', 'append', 'showcase', 'pipes', 'dense-no-combining'].includes(workload),
  ),
);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalize = (text) =>
  text
    .split('\n')
    .map((row) => row.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
async function fingerprints() {
  const hashes = {};
  for (const dir of ['packages/wraith/src', 'packages/wraith/wasm', 'scripts/competitors']) {
    for (const file of (await readdir(join(root, dir))).sort()) {
      if (!/\.(?:js|ts|mjs|wasm|html|json)$/.test(file)) continue;
      const path = join(dir, file);
      hashes[path] = sha(await readFile(join(root, path)));
    }
  }
  for (const path of [
    'demo/compare.js',
    'demo/showcase.js',
    'demo/pipes-scene.js',
    'demo/fonts/JetBrainsMono-Regular.ttf',
  ])
    hashes[path] = sha(await readFile(join(root, path)));
  for (const pkg of ['restty', 'ghostty-web']) {
    const directory = `.cache/competitor-packages/node_modules/${pkg}/dist`;
    for (const file of (await readdir(join(root, directory))).sort()) {
      if (!/\.(js|wasm)$/.test(file)) continue;
      const path = join(directory, file);
      hashes[path] = sha(await readFile(join(root, path)));
    }
  }
  const ghosttyWasm = '.cache/competitor-packages/node_modules/ghostty-web/ghostty-vt.wasm';
  hashes[ghosttyWasm] = sha(await readFile(join(root, ghosttyWasm)));
  return hashes;
}
const hashes = await fingerprints();
const data = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  packages: JSON.parse(await readFile(join(import.meta.dirname, 'package-lock.json'))),
  xtermVersion: JSON.parse(await readFile(join(root, 'node_modules/@xterm/xterm/package.json')))
    .version,
  webglVersion: JSON.parse(
    await readFile(join(root, 'node_modules/@xterm/addon-webgl/package.json')),
  ).version,
  hashes,
  adapterGeneration: JSON.parse(
    await readFile(join(root, '.cache/competitor-packages/adapter-source.json')),
  ),
  hardware: {
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryGiB: totalmem() / 2 ** 30,
    platform: platform(),
    release: release(),
  },
  settings: {
    headless: true,
    cols: 240,
    rows: 80,
    scrollback: 0,
    font: 'JetBrainsMono-Regular.ttf',
    fontSize: 15,
    frames,
    warmup,
    repetitions,
    targets,
    conditions,
    restty: { ligatures: false, fontSizeMode: 'em', alphaBlending: 'native', fontHinting: false },
    ghosttyWeb: { lineBoxHeight: 20, defaultLineHeightOverridden: true },
    input:
      'identical UTF-8 bytes; Restty decode included because its public runtime accepts strings',
    measurement:
      'manual existing renderer turn per update; WebGPU/WebGL fences every 32 and final; Canvas2D readback every 32 and final; no physical presentation FPS',
  },
  results: [],
  errors: [],
  mismatches: [],
};
await mkdir(output, { recursive: true });
const save = () => writeFile(join(output, 'runs.json'), JSON.stringify(data, null, 2) + '\n');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: join(root, '.cache/competitor-vite'),
  server: { host: '127.0.0.1', port: 5196, strictPort: true },
  optimizeDeps: { include: ['@xterm/xterm', '@xterm/addon-webgl'] },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const initialReferences = new Map(),
  finalReferences = new Map();
function firstDifference(actual, expected) {
  let offset = 0;
  while (actual[offset] === expected[offset] && offset < Math.max(actual.length, expected.length))
    offset++;
  return {
    offset,
    actual: actual.slice(Math.max(0, offset - 30), offset + 100),
    expected: expected.slice(Math.max(0, offset - 30), offset + 100),
    actualLength: actual.length,
    expectedLength: expected.length,
  };
}
try {
  for (const condition of conditions) {
    const context = await browser.newContext({
      viewport: { width: 2600, height: 2100 },
      deviceScaleFactor: condition.dpr,
    });
    for (let repeat = 0; repeat < repetitions; repeat++) {
      let order = targets.map((_, i) => targets[(i + repeat) % targets.length]);
      if (repeat % 2) order.reverse();
      for (const target of order) {
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text());
        });
        try {
          await page.goto('http://127.0.0.1:5196/scripts/competitors/browser.html');
          await page.waitForFunction(() => window.competitor?.ready, undefined, { timeout: 30000 });
          const scene = await page.evaluate(
            ({ target, workload }) => window.competitor.setup(target, workload),
            { target, ...condition },
          );
          const key = `${condition.workload}/${condition.dpr}`;
          const geometry = { width: 2160 * condition.dpr, height: 1600 * condition.dpr };
          let geometryMatches =
            scene.geometry.width === geometry.width && scene.geometry.height === geometry.height;
          const inputsSha256 = scene.inputsSha256;
          const initialText = normalize(scene.text);
          if (!initialReferences.has(key))
            initialReferences.set(key, { target, text: initialText, inputsSha256 });
          const initialRef = initialReferences.get(key);
          assert.equal(inputsSha256, initialRef.inputsSha256, 'Input workload differs');
          const initialMatches = initialText === initialRef.text;
          const publicTextMatches =
            scene.publicText === undefined
              ? undefined
              : normalize(scene.publicText) === initialText;
          if (publicTextMatches === false)
            data.mismatches.push({
              target,
              ...condition,
              repeat,
              phase: 'public-buffer-text',
              reference: 'same terminal grapheme-aware core snapshot',
              ...firstDifference(normalize(scene.publicText), initialText),
            });
          if (!initialMatches)
            data.mismatches.push({
              target,
              ...condition,
              repeat,
              phase: 'initial',
              reference: initialRef.target,
              ...firstDifference(initialText, initialRef.text),
            });
          if (!geometryMatches)
            data.mismatches.push({
              target,
              ...condition,
              repeat,
              phase: 'geometry',
              actual: scene.geometry,
              expected: geometry,
            });
          const systemLoadBefore = loadavg();
          const result = await page.evaluate((config) => window.competitor.run(config), {
            frames,
            warmup,
          });
          const systemLoadAfter = loadavg();
          geometryMatches &&=
            result.geometry.width === geometry.width && result.geometry.height === geometry.height;
          const finalText = normalize(result.text);
          assert.deepEqual(pageErrors, [], 'Browser errors invalidate a timing run');
          if (!finalReferences.has(key)) finalReferences.set(key, { target, text: finalText });
          const finalRef = finalReferences.get(key),
            finalMatches = finalText === finalRef.text;
          if (!finalMatches)
            data.mismatches.push({
              target,
              ...condition,
              repeat,
              phase: 'final',
              reference: finalRef.target,
              ...firstDifference(finalText, finalRef.text),
            });
          data.userAgent ??= await page.evaluate(() => navigator.userAgent);
          data.adapter ??= await page.evaluate(async () => {
            const a = await navigator.gpu.requestAdapter();
            return a
              ? {
                  vendor: a.info.vendor,
                  architecture: a.info.architecture,
                  device: a.info.device,
                  description: a.info.description,
                }
              : null;
          });
          const { text, ...measurements } = result;
          data.results.push({
            target,
            ...condition,
            repeat,
            renderer: scene.renderer,
            ...measurements,
            systemLoadBefore,
            systemLoadAfter,
            initialTextSha256: sha(initialText),
            finalTextSha256: sha(finalText),
            inputsSha256,
            bytesPerVariant: scene.bytesPerVariant,
            validation: { initialMatches, finalMatches, geometryMatches },
            publicTextMatches,
            pageErrors,
          });
          if (probe) {
            await writeFile(join(output, `${target}-text.txt`), initialText);
            await page.screenshot({ path: join(output, `${target}-dpr${condition.dpr}.png`) });
          }
          await save();
          console.log(
            `${condition.workload} DPR${condition.dpr} #${repeat + 1} ${target}: ${result.updatesPerSecond.toFixed(1)}/s; parse ${result.parseMs.p50.toFixed(3)}ms; render ${result.renderMs.p50.toFixed(3)}ms; text=${initialMatches && finalMatches} geometry=${geometryMatches} errors=${pageErrors.length}`,
          );
        } catch (error) {
          data.errors.push({ target, ...condition, repeat, error: String(error), pageErrors });
          await save();
          console.log(`FAILED ${target}: ${error}`);
          if (!probe) throw error;
        } finally {
          await page.evaluate(() => window.competitor?.dispose()).catch(() => {});
          await page.close();
        }
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
assert.deepEqual(await fingerprints(), hashes, 'Sources changed during benchmark');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const groups = conditions.map((condition) => ({
  ...condition,
  targets: Object.fromEntries(
    targets.map((target) => {
      const runs = data.results.filter(
        (r) => r.target === target && r.workload === condition.workload && r.dpr === condition.dpr,
      );
      if (!runs.length) return [target, null];
      const rates = runs.map((r) => r.updatesPerSecond);
      return [
        target,
        {
          median: median(rates),
          range: [Math.min(...rates), Math.max(...rates)],
          runs: rates,
          parseP50Ms: median(runs.map((r) => r.parseMs.p50)),
          renderP50Ms: median(runs.map((r) => r.renderMs.p50)),
          gpuFenced: runs[0].gpuFenced,
          validation: runs.every((r) => Object.values(r.validation).every(Boolean)),
          errors: runs.flatMap((r) => r.pageErrors),
        },
      ];
    }),
  ),
}));
await writeFile(
  join(output, 'summary.json'),
  JSON.stringify(
    {
      head: data.head,
      date: data.date,
      settings: data.settings,
      groups,
      errors: data.errors,
      mismatches: data.mismatches,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Saved ${relative(root, output)}: ${data.results.length} runs, ${data.errors.length} failures, ${data.mismatches.length} output/geometry mismatches.`,
);
