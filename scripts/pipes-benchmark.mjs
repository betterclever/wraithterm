import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem, platform, release } from 'node:os';
import {
  pipesWorkload,
  createPipesScene,
  rasterizePipes,
  PIPE_PRESETS,
} from '../demo/pipes-scene.js';
import { pixels } from './png.mjs';

const root = process.cwd(),
  output = resolve(process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/pipes');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const repetitions = Number(process.env.WRAITH_REPETITIONS ?? 3),
  frames = Number(process.env.WRAITH_FRAMES ?? 256);
assert(Number.isInteger(repetitions) && repetitions > 0);
assert(Number.isInteger(frames) && frames >= 32 && frames <= 4096);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sources = [
  ...(await readdir('packages/wraith/src'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => 'packages/wraith/src/' + f),
  'packages/wraith/wasm/wraith_engine_bg.wasm',
  'demo/pipes-scene.js',
  'demo/compare.js',
  'scripts/pipes-benchmark.mjs',
  'demo/fonts/JetBrainsMono-Regular.ttf',
];
const fingerprint = async () =>
  Object.fromEntries(
    await Promise.all(sources.map(async (f) => [f, sha(await readFile(join(root, f)))])),
  );
const inputs = Array.from({ length: 8 }, (_, i) => pipesWorkload(240, 80, i));
const inputHashes = inputs.map((v) => sha(v.bytes));
const expected = rasterizePipes(createPipesScene(PIPE_PRESETS.inferno), 0).pixels;
const metadata = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sources: await fingerprint(),
  hardware: {
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryGiB: totalmem() / 2 ** 30,
    platform: platform(),
    release: release(),
  },
  xterm: JSON.parse(await readFile('node_modules/@xterm/xterm/package.json')).version,
  webglAddon: JSON.parse(await readFile('node_modules/@xterm/addon-webgl/package.json')).version,
  scene: inputs[0].scene,
  inputHashes,
  bytesPerVariant: inputs.map((i) => i.bytes.length),
  repetitions,
  frames,
  grid: { cols: 240, rows: 80 },
  dpr: 1,
  headless: true,
  method:
    'Eight precomputed ANSI frames. Warm 32 updates. GPU fence every 32 updates plus final fence. Scene generation excluded. Public write/onRender cadence reported separately.',
  results: [],
  errors: [],
};
await mkdir(output, { recursive: true });
await mkdir('.cache/pipes', { recursive: true });
const save = () => writeFile(join(output, 'runs.json'), JSON.stringify(metadata, null, 2) + '\n');
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 2600, height: 2100 },
    deviceScaleFactor: 1,
  });
  const types = ['wraith', 'webgl', 'ghostty'];
  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (let index = 0; index < types.length; index++) {
      const type = types[(index + repeat) % types.length];
      const page = await context.newPage(),
        pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(m.text());
      });
      try {
        await page.goto(`${base}/compare.html?type=${type}&workload=pipes`);
        await page.waitForFunction(() => window.comparison?.ready);
        const setup = await page.evaluate(() => window.comparison.ready);
        assert(setup, await page.evaluate(() => window.failure));
        // Verify identical bytes in the browser and Node, not just identical block text.
        const hashes = await page.evaluate(async () =>
          Promise.all(
            Array.from({ length: 8 }, async (_, i) => {
              const bytes = window.comparison.workload(240, 80, i, 'pipes').bytes;
              return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
                v.toString(16).padStart(2, '0'),
              ).join('');
            }),
          ),
        );
        assert.deepEqual(hashes, inputHashes);
        const png = await page.locator('#scene').screenshot(),
          image = pixels(png);
        const cell = setup.dimensions.css.cell;
        let exact = 0,
          near = 0;
        for (let y = 0; y < 160; y++)
          for (let x = 0; x < 240; x++) {
            const sx = Math.floor((x + 0.5) * cell.width),
              sy = Math.floor((y / 2 + 0.25) * cell.height);
            const at = (sy * image.width + sx) * image.bpp,
              color = expected[y * 240 + x];
            const difference = Math.max(
              Math.abs(image.data[at] - (color >>> 16)),
              Math.abs(image.data[at + 1] - ((color >>> 8) & 255)),
              Math.abs(image.data[at + 2] - (color & 255)),
            );
            if (difference === 0) exact++;
            if (difference <= 2) near++;
          }
        assert.equal(near, 38400, `${type}: rendered half-cell colors differ (${near}/38400)`);
        if (repeat === 0) await writeFile(join('.cache/pipes', `benchmark-${type}.png`), png);
        metadata.userAgent ??= await page.evaluate(() => navigator.userAgent);
        metadata.adapters ??= await page.evaluate(() => window.comparison.adapterInfo());
        const result = await page.evaluate(async (frames) => {
          let timeout;
          try {
            return await Promise.race([
              window.comparison.run({
                type: new URLSearchParams(location.search).get('type'),
                workload: 'pipes',
                cols: 240,
                rows: 80,
                frames,
              }),
              new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Pipes benchmark timed out')), 60000);
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
        }, frames);
        assert.equal(result.gpuFenced, true);
        if (result.submittedFrames !== undefined) assert.equal(result.submittedFrames, frames);
        assert.deepEqual(pageErrors, []);
        metadata.results.push({
          repeat,
          colors: { exact, withinTwo: near, total: 38400 },
          ...result,
        });
        await save();
        console.log(
          `${type} #${repeat + 1}: ${result.pipelineUpdatesPerSecond.toFixed(1)} GPU-completed updates/s; parse p50 ${result.parseMs.p50.toFixed(2)}ms; redraw p50 ${result.renderAndLayoutMs.p50.toFixed(2)}ms`,
        );
      } catch (error) {
        metadata.errors.push({ type, repeat, error: String(error), pageErrors });
        await save();
        throw error;
      } finally {
        await page.evaluate(() => window.comparison?.dispose()).catch(() => {});
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
assert.deepEqual(await fingerprint(), metadata.sources, 'Sources changed during the benchmark');
const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
const summary = ['wraith', 'webgl', 'ghostty'].map((type) => {
  const runs = metadata.results.filter((r) => r.type === type),
    rates = runs.map((r) => r.pipelineUpdatesPerSecond);
  return {
    type,
    completedUpdatesPerSecond: median(rates),
    range: [Math.min(...rates), Math.max(...rates)],
    parseP50Ms: median(runs.map((r) => r.parseMs.p50)),
    redrawP50Ms: median(runs.map((r) => r.renderAndLayoutMs.p50)),
    pipelineP95Ms: median(runs.map((r) => r.pipelineCpuMs.p95)),
  };
});
await writeFile(
  join(output, 'summary.json'),
  JSON.stringify({ date: metadata.date, repetitions, frames, summary }, null, 2) + '\n',
);
console.log(JSON.stringify(summary, null, 2));
