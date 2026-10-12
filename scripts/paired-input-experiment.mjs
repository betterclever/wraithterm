import { chromium } from '@playwright/test';
import { parameterPrototype, bulkPrint } from './performance-experiments/input.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import assert from 'node:assert/strict';
const root = process.cwd(),
  output = process.env.WRAITH_REPORT_DIR ?? '.cache/performance-experiments/paired';
const pairs = Number(process.env.WRAITH_PAIRS ?? 80),
  frames = 32;
assert(Number.isInteger(pairs) && pairs >= 20 && pairs <= 200);
const prototype = await parameterPrototype(root),
  sha = (b) => createHash('sha256').update(b).digest('hex');
await mkdir(output, { recursive: true });
async function interleaved(a, options) {
  const input = a.terminal._core._inputHandler,
    parser = input._parser;
  const originalParser = parser.parse,
    originalPrint = input.print;
  window.__parameterInstall(a.terminal);
  const fastParser = parser.parse;
  window.__bulkPrint(a.terminal);
  const fastPrint = input.print;
  const select = (kind) => {
    parser.parse = kind === 'baseline' ? originalParser : fastParser;
    input.print = kind === 'combined' ? fastPrint : originalPrint;
  };
  for (const kind of ['baseline', 'params', 'combined']) {
    select(kind);
    for (let i = 0; i < 256; i++) {
      a.parse(a.inputs[i % 8].bytes);
      a.draw();
      if ((i + 1) % 32 === 0) await a.finish();
    }
    await a.finish();
  }
  const results = [];
  for (let pair = 0; pair < options.pairs; pair++) {
    let order = pair % 2 ? ['combined', 'params', 'baseline'] : ['baseline', 'params', 'combined'];
    order = order.map((_, i) => order[(i + (pair % 3)) % 3]);
    for (const kind of order) {
      select(kind);
      const before = a.submitted(),
        started = performance.now();
      for (let i = 0; i < options.frames; i++) {
        a.parse(a.inputs[i % 8].bytes);
        a.draw();
      }
      await a.finish();
      const elapsedMs = performance.now() - started,
        submitted = a.submitted() - before;
      if (submitted !== options.frames) throw new Error('Paired submission count mismatch');
      results.push({
        pair,
        kind,
        elapsedMs,
        frames: options.frames,
        submittedFrames: submitted,
        updatesPerSecond: (options.frames * 1000) / elapsedMs,
      });
    }
  }
  select('baseline');
  a.assert();
  return results;
}
const metadata = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  pairs,
  framesPerBlock: frames,
  method:
    'Same terminal and GPU device. Warm each action 256 updates. Alternate/rotate three actions every 32 real input updates, fence every block. All submissions counted. No parser/pixel validation or profiling runs concurrently. Fixed current workload bytes; existing terminal input acceleration retained in all modes. GPU-completed throughput, not presentation FPS.',
  sources: Object.fromEntries(
    await Promise.all(
      [
        'scripts/paired-input-experiment.mjs',
        'scripts/performance-experiments/input.mjs',
        'demo/compare.js',
        'demo/showcase.js',
        'demo/pipes-scene.js',
        'packages/wraith/src/xterm.ts',
        'packages/wraith/src/xterm-input.ts',
        'packages/wraith/src/xterm-renderer.ts',
        'packages/wraith/wasm/wraith_engine_bg.wasm',
      ].map(async (f) => [f, sha(await readFile(f))]),
    ),
  ),
  prototypeSha256: sha(prototype.code),
  results: [],
  errors: [],
};
const save = () => writeFile(output + '/runs.json', JSON.stringify(metadata, null, 2) + '\n');
await save();
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const conditions = ['complex', 'churn', 'append', 'showcase', 'pipes'].map((workload) => ({
    workload,
    dpr: 1,
  }));
  conditions.push({ workload: 'complex', dpr: 2 });
  for (const condition of conditions) {
    const context = await browser.newContext({
      viewport: { width: 2600, height: 2100 },
      deviceScaleFactor: condition.dpr,
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript({
      content: `(()=>{${prototype.code.replace('export function install', 'function install')}window.__parameterInstall=install;window.__bulkPrint=${bulkPrint.toString()};})();`,
    });
    await page.route('**/compare.js*', async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      assert(body.includes('window.comparison = {'));
      body =
        `const interleaved=${interleaved.toString()};\n` +
        body.replace(
          'window.comparison = {',
          'window.comparison = { paired:options=>interleaved(active,options),',
        );
      await route.fulfill({ response, body });
    });
    await page.goto(
      `http://127.0.0.1:5173/compare.html?type=wraith&workload=${condition.workload}`,
    );
    await page.waitForFunction(() => window.comparison?.ready, undefined, { timeout: 60000 });
    assert(await page.evaluate(() => window.comparison.ready));
    metadata.userAgent ??= await page.evaluate(() => navigator.userAgent);
    metadata.adapter ??= await page.evaluate(() => window.comparison.adapterInfo());
    const results = await page.evaluate((options) => window.comparison.paired(options), {
      pairs,
      frames,
    });
    assert.deepEqual(errors, []);
    metadata.results.push({ ...condition, results });
    await save();
    console.log(
      `${condition.workload} DPR${condition.dpr}: ${pairs} rotated baseline/params/combined blocks completed`,
    );
    await page.evaluate(() => window.comparison.dispose());
    await context.close();
  }
} finally {
  await browser.close();
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summary = metadata.results.map((row) => {
  const modes = ['baseline', 'params', 'combined'].map((kind) => {
    const runs = row.results.filter((r) => r.kind === kind),
      rates = runs.map((r) => r.updatesPerSecond);
    const ratios =
      kind === 'baseline'
        ? [1]
        : runs.map(
            (r) =>
              r.updatesPerSecond /
              row.results.find((b) => b.pair === r.pair && b.kind === 'baseline').updatesPerSecond,
          );
    const sorted = [...ratios].sort((a, b) => a - b);
    return {
      kind,
      completedUpdatesPerSecond: median(rates),
      pairedMedianRatio: median(ratios),
      pairedRatioP10: sorted[Math.floor(sorted.length * 0.1)],
      pairedRatioP90: sorted[Math.floor(sorted.length * 0.9)],
    };
  });
  return { workload: row.workload, dpr: row.dpr, modes };
});
for (const [file, hash] of Object.entries(metadata.sources))
  assert.equal(sha(await readFile(file)), hash, 'Source changed during paired batch');
await writeFile(
  output + '/summary.json',
  JSON.stringify({ date: metadata.date, pairs, framesPerBlock: frames, summary }, null, 2) + '\n',
);
console.log(JSON.stringify(summary, null, 2));
