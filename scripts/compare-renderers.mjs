import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pixelSummary } from './png.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = resolve(process.env.WRAITH_REPORT_DIR ?? join(root, 'docs/benchmarks/comparison'));
await mkdir(report, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
});
const sha = (data) => createHash('sha256').update(data).digest('hex');
const packageVersion = async (name) =>
  JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
const results = [];
const references = new Map();
const errors = [];
const cadence = {};
const reps = Number(process.env.WRAITH_REPETITIONS ?? 3);
const types = ['dom', 'webgl', 'wraith', 'ghostty'];
const densities = (process.env.WRAITH_DPRS ?? '1,2').split(',').map(Number);
const workloads = (process.env.WRAITH_WORKLOADS ?? 'complex,churn').split(',');
const metadata = {
  date: new Date().toISOString(),
  grid: { cols: 240, rows: 80, cells: 19200 },
  font: { family: 'JetBrains Mono Regular', sizeCssPx: 15, lineHeight: 1 },
  xterm: await packageVersion('@xterm/xterm'),
  webglAddon: await packageVersion('@xterm/addon-webgl'),
  ghostty: JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8')).ghostty,
  wasmSha256: sha(await readFile(join(root, 'packages/wraith/wasm/wraith_engine_bg.wasm'))),
  fontSha256: sha(await readFile(join(root, 'demo/fonts/JetBrainsMono-Regular.ttf'))),
  repetitions: reps,
  headless: true,
  results,
  cadence,
  errors,
};
if (process.env.WRAITH_APPEND === '1') {
  const previous = JSON.parse(await readFile(join(report, 'chrome.json'), 'utf8'));
  assert.equal(
    previous.wasmSha256,
    metadata.wasmSha256,
    'Cannot append results from another Wasm binary',
  );
  metadata.date = previous.date;
  metadata.appendedAt = new Date().toISOString();
  results.push(...previous.results);
  Object.assign(cadence, previous.cadence);
}
try {
  for (const dpr of densities) {
    const context = await browser.newContext({
      viewport: { width: 2600, height: 2100 },
      deviceScaleFactor: dpr,
    });
    for (const workload of workloads) {
      for (let repeat = 0; repeat < reps; repeat++) {
        const order = types.map((_, i) => types[(i + repeat + (dpr - 1) * 2) % types.length]);
        for (const type of order) {
          const page = await context.newPage();
          const pageErrors = [];
          page.on('pageerror', (e) => pageErrors.push(e.message));
          page.on('console', (m) => {
            if (m.type() === 'error') pageErrors.push(m.text());
          });
          try {
            const url = `${process.env.WRAITH_URL ?? 'http://127.0.0.1:5173'}/compare.html?type=${type}&workload=${workload}`;
            await page.goto(url);
            await page.waitForFunction(() => window.comparison?.ready, undefined, {
              timeout: 30000,
            });
            const scene = await page.evaluate(() => window.comparison.ready);
            assert(scene, await page.evaluate(() => window.failure));
            const key = `${dpr}/${workload}`,
              contentSha256 = sha(scene.text);
            const dimensions = JSON.stringify(scene.dimensions.device.canvas);
            if (!references.has(key)) references.set(key, { contentSha256, dimensions });
            assert.equal(
              contentSha256,
              references.get(key).contentSha256,
              `${type} changed visible text`,
            );
            assert.equal(
              dimensions,
              references.get(key).dimensions,
              `${type} canvas size mismatch`,
            );
            let pixels;
            if (repeat === 0) {
              const png = await page.locator('#scene').screenshot();
              pixels = pixelSummary(png);
              assert(
                pixels.bright > 10000 && pixels.colors > 100,
                `${type}: blank/incorrect scene pixels ${JSON.stringify(pixels)}`,
              );
              await writeFile(join(report, `${workload}-${type}-dpr${dpr}.png`), png);
            }
            if (!cadence[dpr])
              cadence[dpr] = await page.evaluate(() => window.comparison.idleCadence());
            const config = {
              type,
              workload,
              cols: 240,
              rows: 80,
              frames: type === 'dom' ? 64 : 128,
            };
            const result = await page.evaluate((config) => window.comparison.run(config), config);
            result.repeat = repeat;
            result.contentSha256 = contentSha256;
            result.pixels = pixels;
            assert.deepEqual(pageErrors, [], `${type} browser errors`);
            results.push(result);
            metadata.userAgent ??= await page.evaluate(() => navigator.userAgent);
            await writeFile(join(report, 'chrome.json'), JSON.stringify(metadata, null, 2) + '\n');
            console.log(
              `DPR${dpr} ${workload} ${type} #${repeat + 1}: ${result.pipelineUpdatesPerSecond.toFixed(1)} ${result.gpuFenced ? 'GPU-fenced' : 'CPU+layout'} updates/s; parse p50 ${result.parseMs.p50.toFixed(2)}ms; render p50 ${result.renderAndLayoutMs.p50.toFixed(2)}ms; p95 pipeline ${result.pipelineCpuMs.p95.toFixed(2)}ms; ${result.publicApiPacing ? result.publicApiPacing.renderCallbacksPerSecond.toFixed(1) + ' rAF-paced callbacks/s' : 'native core, no SDK pacing'}`,
            );
          } catch (error) {
            errors.push({ dpr, workload, type, repeat, error: String(error), pageErrors });
            await writeFile(join(report, 'chrome.json'), JSON.stringify(metadata, null, 2) + '\n');
            throw error;
          } finally {
            await page.evaluate(() => window.comparison?.dispose()).catch(() => {});
            await page.close();
          }
        }
      }
    }
    await context.close();
  }
  console.log(
    `Comparison complete: ${results.length} runs; text, canvas geometry and pixels verified.`,
  );
} finally {
  await browser.close();
}
