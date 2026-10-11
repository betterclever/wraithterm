// Paired Wraith builds and official xterm WebGL in the same rotated run batch.
// Each pipeline frame is submitted, and GPU completion is fenced every 32 frames.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem, platform, release } from 'node:os';
const root = process.cwd();
const baseline = resolve(process.env.WRAITH_BASELINE_DIR ?? '.cache/retained-rows-baseline');
const output = resolve(process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/retained-rows');
const repetitions = Number(process.env.WRAITH_REPETITIONS ?? 3);
const frames = Number(process.env.WRAITH_FRAMES ?? 512);
assert(Number.isInteger(repetitions) && repetitions > 0);
assert(Number.isInteger(frames) && frames >= 32 && frames <= 4096);
const sha = (data) => createHash('sha256').update(data).digest('hex');
// xterm includes right-padding and every blank viewport row in its text API;
// native text omits that padding. Preserve all non-padding content for hashes.
const textHash = (text) =>
  sha(
    text
      .split('\n')
      .map((row) => row.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n+$/, ''),
  );
const builds = {};
for (const [name, directory] of [
  ['before', baseline],
  ['after', root],
]) {
  builds[name] = {
    directory,
    head:
      name === 'before'
        ? JSON.parse(await readFile(join(directory, 'baseline.json'))).head
        : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    wasmSha256: sha(await readFile(join(directory, 'packages/wraith/wasm/wraith_engine_bg.wasm'))),
    rendererSha256: sha(await readFile(join(directory, 'packages/wraith/src/xterm-renderer.ts'))),
  };
}
const before = process.env.WRAITH_BEFORE_URL ?? 'http://127.0.0.1:5190';
const after = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const targets = [
  { name: 'wraith-before', type: 'wraith', url: before },
  { name: 'wraith-after', type: 'wraith', url: after },
  { name: 'xterm-webgl', type: 'webgl', url: after },
  { name: 'native-before', type: 'ghostty', url: before },
  { name: 'native-after', type: 'ghostty', url: after },
];
const conditions = [
  ...(process.env.WRAITH_WORKLOADS ?? 'complex,churn,append,showcase')
    .split(',')
    .map((workload) => ({ workload, dpr: 1 })),
  ...((process.env.WRAITH_DPRS ?? '1,2').includes('2') ? [{ workload: 'complex', dpr: 2 }] : []),
];
const results = [],
  errors = [];
const metadata = {
  date: new Date().toISOString(),
  builds,
  repetitions,
  frames,
  headless: true,
  textNormalization: 'remove trailing ASCII spaces/tabs per row and trailing empty rows',
  grid: { cols: 240, rows: 80, cells: 19200 },
  conditions,
  xterm: JSON.parse(await readFile(join(root, 'node_modules/@xterm/xterm/package.json'))).version,
  webglAddon: JSON.parse(await readFile(join(root, 'node_modules/@xterm/addon-webgl/package.json')))
    .version,
  hardware: {
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryGiB: totalmem() / 2 ** 30,
    platform: platform(),
    release: release(),
  },
  results,
  errors,
};
await mkdir(output, { recursive: true });
const save = () => writeFile(join(output, 'runs.json'), JSON.stringify(metadata, null, 2) + '\n');
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  for (const { workload, dpr } of conditions) {
    const context = await browser.newContext({
      viewport: { width: 2600, height: 2100 },
      deviceScaleFactor: dpr,
    });
    for (let repeat = 0; repeat < repetitions; repeat++) {
      // Rotate the starting target, then reverse every other repetition.
      let order = targets.map((_, i) => targets[(i + repeat) % targets.length]);
      if (repeat % 2) order.reverse();
      let initial, final;
      for (const target of order) {
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        page.on('console', (m) => {
          if (m.type() === 'error') pageErrors.push(m.text());
        });
        try {
          await page.goto(`${target.url}/compare.html?type=${target.type}&workload=${workload}`);
          await page.waitForFunction(() => window.comparison?.ready, undefined, { timeout: 30000 });
          const scene = await page.evaluate(() => window.comparison.ready);
          assert(scene, await page.evaluate(() => window.failure));
          const signature = {
            textSha256: textHash(scene.text),
            canvas: scene.dimensions.device.canvas,
          };
          initial ??= signature;
          assert.deepEqual(signature, initial, 'Initial text or geometry changed');
          const result = await page.evaluate((config) => window.comparison.run(config), {
            type: target.type,
            workload,
            cols: 240,
            rows: 80,
            frames,
          });
          const finalTextSha256 = textHash(await page.evaluate(() => window.comparison.text()));
          final ??= finalTextSha256;
          assert.equal(finalTextSha256, final, 'Final visible text changed');
          assert.equal(result.gpuFenced, true);
          if (result.submittedFrames !== undefined) assert.equal(result.submittedFrames, frames);
          assert.deepEqual(pageErrors, []);
          metadata.userAgent ??= await page.evaluate(() => navigator.userAgent);
          metadata.adapters ??= await page.evaluate(() => window.comparison.adapterInfo());
          results.push({
            target: target.name,
            repeat,
            ...result,
            initialTextSha256: signature.textSha256,
            finalTextSha256,
          });
          await save();
          console.log(
            `DPR${dpr} ${workload} #${repeat + 1} ${target.name}: ${result.pipelineUpdatesPerSecond.toFixed(1)} completed updates/s; redraw p50 ${result.renderAndLayoutMs.p50.toFixed(3)}ms; uploads ${JSON.stringify(result.gpuUploadBytes ?? {})}`,
          );
        } catch (error) {
          errors.push({
            target: target.name,
            workload,
            dpr,
            repeat,
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
    await context.close();
  }
} finally {
  await browser.close();
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const groups = conditions.map(({ workload, dpr }) => {
  const summaries = {};
  for (const target of targets) {
    const runs = results.filter(
      (r) => r.target === target.name && r.workload === workload && r.dpr === dpr,
    );
    assert.equal(runs.length, repetitions);
    summaries[target.name] = {
      completedUpdatesPerSecond: median(runs.map((r) => r.pipelineUpdatesPerSecond)),
      range: [
        Math.min(...runs.map((r) => r.pipelineUpdatesPerSecond)),
        Math.max(...runs.map((r) => r.pipelineUpdatesPerSecond)),
      ],
      redrawP50Ms: median(runs.map((r) => r.renderAndLayoutMs.p50)),
      pipelineP95Ms: median(runs.map((r) => r.pipelineCpuMs.p95)),
      cellUploadBytesPerUpdate: runs[0].gpuUploadBytes?.cells / frames,
      rowMapBytesPerUpdate: runs[0].gpuUploadBytes?.rowMap / frames,
    };
  }
  const rate = (key) => summaries[key].completedUpdatesPerSecond;
  return {
    workload,
    dpr,
    targets: summaries,
    wraithGain: rate('wraith-after') / rate('wraith-before') - 1,
    nativeGain: rate('native-after') / rate('native-before') - 1,
    wraithVsXterm: rate('wraith-after') / rate('xterm-webgl'),
    nativeVsXterm: rate('native-after') / rate('xterm-webgl'),
  };
});
await writeFile(
  join(output, 'summary.json'),
  JSON.stringify({ date: metadata.date, builds, repetitions, frames, groups }, null, 2) + '\n',
);
console.log(JSON.stringify(groups, null, 2));
