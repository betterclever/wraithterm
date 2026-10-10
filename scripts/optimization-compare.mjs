import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const baseline = resolve(process.env.WRAITH_BASELINE_DIR ?? '../../work/top-tier-baseline');
const output = resolve(process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/optimization');
await mkdir(output, { recursive: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const versions = [
  { name: 'before', root: baseline, url: process.env.WRAITH_BEFORE_URL ?? 'http://127.0.0.1:5190' },
  { name: 'after', root, url: process.env.WRAITH_URL ?? 'http://127.0.0.1:5173' },
];
for (const v of versions) {
  v.wasmSha256 = hash(await readFile(join(v.root, 'packages/wraith/wasm/wraith_engine_bg.wasm')));
  v.rendererSha256 = hash(await readFile(join(v.root, 'packages/wraith/src/xterm-renderer.ts')));
}
const repetitions = Number(process.env.WRAITH_REPETITIONS ?? 3);
const frames = Number(process.env.WRAITH_FRAMES ?? 128);
const types = (process.env.WRAITH_TYPES ?? 'wraith,ghostty').split(',');
const dprs = (process.env.WRAITH_DPRS ?? '1,2').split(',').map(Number);
const workloads = (process.env.WRAITH_WORKLOADS ?? 'complex,churn,scroll').split(',');
assert(Number.isInteger(repetitions) && repetitions > 0);
assert(Number.isInteger(frames) && frames >= 32 && frames <= 4096);
assert(types.length && types.every((type) => ['wraith', 'ghostty'].includes(type)));
assert(dprs.length && dprs.every((dpr) => [1, 2].includes(dpr)));
assert(
  workloads.length &&
    workloads.every((workload) => ['complex', 'churn', 'scroll', 'append'].includes(workload)),
);
const results = [],
  errors = [];
const metadata = {
  date: new Date().toISOString(),
  headless: true,
  versions,
  repetitions,
  frames,
  types,
  dprs,
  workloads,
  results,
  errors,
};
const save = () =>
  writeFile(join(output, 'optimization.json'), JSON.stringify(metadata, null, 2) + '\n');
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  for (const dpr of dprs) {
    const context = await browser.newContext({
      viewport: { width: 2600, height: 2100 },
      deviceScaleFactor: dpr,
    });
    for (const workload of dpr === 1 ? workloads : workloads.filter((w) => w === 'complex')) {
      for (const type of types) {
        for (let repeat = 0; repeat < repetitions; repeat++) {
          let reference;
          const order = repeat % 2 ? [...versions].reverse() : versions;
          for (const version of order) {
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            page.on('console', (m) => {
              if (m.type() === 'error') pageErrors.push(m.text());
            });
            try {
              await page.goto(`${version.url}/compare.html?type=${type}&workload=${workload}`);
              await page.waitForFunction(() => window.comparison?.ready, undefined, {
                timeout: 30000,
              });
              const scene = await page.evaluate(() => window.comparison.ready);
              assert(scene, await page.evaluate(() => window.failure));
              reference ??= scene;
              assert.equal(scene.text, reference.text, 'Initial visible text changed');
              assert.deepEqual(scene.dimensions, reference.dimensions, 'Canvas geometry changed');
              const result = await page.evaluate((config) => window.comparison.run(config), {
                type,
                workload,
                cols: 240,
                rows: 80,
                frames,
              });
              assert.deepEqual(pageErrors, []);
              results.push({
                version: version.name,
                repeat,
                ...result,
                textSha256: hash(await page.evaluate(() => window.comparison.text())),
              });
              await save();
              console.log(
                `DPR${dpr} ${workload} ${type} #${repeat + 1} ${version.name}: ${result.pipelineUpdatesPerSecond.toFixed(1)} updates/s; redraw p50 ${result.renderAndLayoutMs.p50.toFixed(2)}ms; pipeline p95 ${result.pipelineCpuMs.p95.toFixed(2)}ms`,
              );
            } catch (error) {
              errors.push({
                type,
                workload,
                repeat,
                version: version.name,
                dpr,
                error: String(error),
                pageErrors,
              });
              await save();
              throw error;
            } finally {
              await page.evaluate(() => window.comparison?.dispose()).catch(() => {});
              await page.close();
            }
          }
        }
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const groups = [];
for (const dpr of dprs)
  for (const workload of dpr === 1 ? workloads : workloads.filter((w) => w === 'complex'))
    for (const type of types) {
      const pair = {};
      for (const v of versions) {
        const runs = results.filter(
          (r) =>
            r.version === v.name && r.dpr === dpr && r.workload === workload && r.type === type,
        );
        assert.equal(runs.length, repetitions);
        pair[v.name] = {
          updatesPerSecond: median(runs.map((r) => r.pipelineUpdatesPerSecond)),
          redrawP50Ms: median(runs.map((r) => r.renderAndLayoutMs.p50)),
          pipelineP95Ms: median(runs.map((r) => r.pipelineCpuMs.p95)),
          range: [
            Math.min(...runs.map((r) => r.pipelineUpdatesPerSecond)),
            Math.max(...runs.map((r) => r.pipelineUpdatesPerSecond)),
          ],
        };
      }
      groups.push({
        type,
        workload,
        dpr,
        ...pair,
        speedRatio: pair.after.updatesPerSecond / pair.before.updatesPerSecond,
      });
    }
await writeFile(
  join(output, 'summary.json'),
  JSON.stringify({ date: metadata.date, repetitions, versions, groups }, null, 2) + '\n',
);
console.log(`Saved ${results.length} interleaved before/after runs.`, JSON.stringify(groups));
