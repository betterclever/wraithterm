import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import assert from 'node:assert/strict';
const baselineRef = execFileSync(
  'git',
  ['rev-parse', process.env.WRAITH_BASELINE_REF ?? '2186929'],
  { encoding: 'utf8' },
).trim();
const baselineParser = execFileSync(
  'git',
  ['show', baselineRef + ':packages/wraith/src/xterm-parser.js'],
  { encoding: 'utf8' },
).replace('export function', 'function');
const baselineInput = execFileSync(
  'git',
  ['show', baselineRef + ':packages/wraith/src/xterm-input.ts'],
  { encoding: 'utf8' },
);
const { default: ts } = await import('typescript');
const compiledInput = ts.transpileModule(baselineInput, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const actionStart = compiledInput.indexOf('input.charAttributes = function');
const baselineSgr = compiledInput.slice(
  actionStart + 'input.charAttributes = '.length,
  compiledInput.lastIndexOf('\n}'),
);
const root = process.cwd(),
  output = process.env.WRAITH_REPORT_DIR ?? '.cache/next-input-paired';
const pairs = Number(process.env.WRAITH_PAIRS ?? 40),
  frames = Number(process.env.WRAITH_FRAMES ?? 256);
const parseOnly = process.env.WRAITH_PARSE_ONLY === '1';
assert(Number.isInteger(pairs) && pairs >= 20 && pairs <= 200);
assert(Number.isInteger(frames) && frames >= 32 && frames <= 4096 && frames % 32 === 0);
const sha = (b) => createHash('sha256').update(b).digest('hex');
await mkdir(output, { recursive: true });
async function interleaved(a, options) {
  const input = a.terminal._core._inputHandler,
    parser = input._parser;
  const productionParser = parser.parse,
    productionSgr = input.charAttributes;
  const originalSgr = Object.getPrototypeOf(input).charAttributes;
  const baselineParser = new Function(
    '"use strict";\n' + options.baselineParser + '\nreturn fastParse;',
  )();
  const baselineSgr = new Function('attributes', '"use strict";\nreturn ' + options.baselineSgr)(
    originalSgr,
  );
  const kinds = ['baseline', 'production'];
  const select = (kind) => {
    parser.parse = kind === 'baseline' ? baselineParser : productionParser;
    input.charAttributes = kind === 'baseline' ? baselineSgr : productionSgr;
  };
  for (const kind of kinds) {
    select(kind);
    for (let i = 0; i < 256; i++) {
      a.parse(a.inputs[i % 8].bytes);
      if (!options.parseOnly) {
        a.draw();
        if ((i + 1) % 32 === 0) await a.finish();
      }
    }
    await a.finish();
  }
  const results = [];
  for (let pair = 0; pair < options.pairs; pair++) {
    const order = pair % 2 ? [...kinds].reverse() : kinds;
    for (const kind of order) {
      select(kind);
      const before = a.submitted(),
        started = performance.now();
      for (let i = 0; i < options.frames; i++) {
        a.parse(a.inputs[i % 8].bytes);
        if (!options.parseOnly) {
          a.draw();
          if ((i + 1) % 32 === 0) await a.finish();
        }
      }
      if (!options.parseOnly) await a.finish();
      const elapsedMs = performance.now() - started,
        submitted = a.submitted() - before;
      if (submitted !== (options.parseOnly ? 0 : options.frames))
        throw new Error('Paired submission count mismatch');
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
  select('production');
  a.assert();
  return results;
}
const metadata = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  baselineRef,
  baselineParser,
  baselineSgr,
  pairs,
  framesPerBlock: frames,
  stage: parseOnly ? 'CPU parse only; zero GPU submissions' : 'GPU-completed pipeline',
  method:
    'Same terminal and GPU device. Warm each action 256 updates. Alternate baseline/current production parser and SGR actions in configurable blocks. Pipeline mode fences every 32 updates and at block end; CPU-only mode never submits a GPU frame. All submissions counted. No other benchmark agents run concurrently; unrelated desktop activity remains possible. Baseline actions extracted from the recorded immutable Git commit; remaining code and workload bytes shared. Neither mode measures presentation FPS.',
  sources: Object.fromEntries(
    await Promise.all(
      [
        'scripts/paired-next-input.mjs',
        'scripts/generate-xterm-parser.mjs',
        'packages/wraith/src/xterm-parser.js',
        'packages/wraith/src/xterm-print.ts',
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
  const conditions = [
    ...(process.env.WRAITH_WORKLOADS ?? 'complex,churn,append,showcase,pipes').split(','),
  ].map((workload) => ({
    workload,
    dpr: 1,
  }));
  if (process.env.WRAITH_DPR2 !== '0') conditions.push({ workload: 'complex', dpr: 2 });
  for (const condition of conditions) {
    const context = await browser.newContext({
      viewport: { width: 2600, height: 2100 },
      deviceScaleFactor: condition.dpr,
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
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
      `${process.env.WRAITH_URL ?? 'http://127.0.0.1:5201'}/compare.html?type=wraith&workload=${condition.workload}`,
    );
    await page.waitForFunction(() => window.comparison?.ready, undefined, { timeout: 60000 });
    assert(await page.evaluate(() => window.comparison.ready));
    metadata.userAgent ??= await page.evaluate(() => navigator.userAgent);
    metadata.adapter ??= await page.evaluate(() => window.comparison.adapterInfo());
    const results = await page.evaluate((options) => window.comparison.paired(options), {
      pairs,
      frames,
      baselineParser,
      baselineSgr,
      parseOnly,
    });
    assert.deepEqual(errors, []);
    metadata.results.push({ ...condition, results });
    await save();
    console.log(
      `${condition.workload} DPR${condition.dpr}: ${pairs} alternating baseline/production blocks completed`,
    );
    await page.evaluate(() => window.comparison.dispose());
    await context.close();
  }
} catch (error) {
  metadata.errors.push(String(error));
  await save();
  throw error;
} finally {
  await browser.close();
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summary = metadata.results.map((row) => {
  const modes = ['baseline', 'production'].map((kind) => {
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
      [parseOnly ? 'parsedUpdatesPerSecond' : 'completedUpdatesPerSecond']: median(rates),
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
  JSON.stringify(
    { date: metadata.date, stage: metadata.stage, pairs, framesPerBlock: frames, summary },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(summary, null, 2));
