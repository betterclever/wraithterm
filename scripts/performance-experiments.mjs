import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem, release } from 'node:os';
import { parameterPrototype, bulkPrint } from './performance-experiments/input.mjs';
import { inputFixtures } from './performance-experiments/fixtures.mjs';
import {
  installPacking,
  validatePacking,
  stageCeiling,
  installFused,
  validateFused,
} from './performance-experiments/browser.mjs';
import { pixels } from './png.mjs';

const root = process.cwd(),
  base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const output = process.env.WRAITH_REPORT_DIR ?? '.cache/performance-experiments/pilot';
const frames = Number(process.env.WRAITH_FRAMES ?? 512),
  repetitions = Number(process.env.WRAITH_REPETITIONS ?? 3);
const workloads = (process.env.WRAITH_WORKLOADS ?? 'complex,churn,append,showcase,pipes').split(
  ',',
);
const kinds = (
  process.env.WRAITH_EXPERIMENTS ??
  'baseline,params,print,combined,wasm-scalar,wasm-simd,combined-simd,fused,combined-fused'
).split(',');
const dprs = (process.env.WRAITH_DPRS ?? '1').split(',').map(Number);
assert(Number.isInteger(frames) && frames >= 32 && frames <= 4096);
assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
assert(
  kinds.every((k) =>
    [
      'baseline',
      'params',
      'print',
      'combined',
      'wasm-scalar',
      'wasm-simd',
      'combined-simd',
      'fused',
      'combined-fused',
    ].includes(k),
  ),
);
assert(workloads.every((w) => ['complex', 'churn', 'append', 'showcase', 'pipes'].includes(w)));
assert(dprs.every((d) => d === 1 || d === 2));
await mkdir(output, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const parameter = await parameterPrototype(root);
await mkdir('.cache/performance-experiments', { recursive: true });
execFileSync(process.env.RUSTC ?? 'rustc', [
  'scripts/performance-experiments/packing.rs',
  '--edition',
  '2021',
  '--crate-type',
  'cdylib',
  '--target',
  'wasm32-unknown-unknown',
  '-C',
  'opt-level=3',
  '-C',
  'panic=abort',
  '-C',
  'target-feature=+simd128',
  '-o',
  '.cache/performance-experiments/packing.wasm',
]);
const packing = await readFile('.cache/performance-experiments/packing.wasm');
const files = [
  ...(await readdir('packages/wraith/src'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => 'packages/wraith/src/' + f),
  'packages/wraith/wasm/wraith_engine_bg.wasm',
  'demo/compare.js',
  'demo/pipes-scene.js',
  'demo/showcase.js',
  'scripts/performance-experiments.mjs',
  ...(await readdir('scripts/performance-experiments')).map(
    (f) => 'scripts/performance-experiments/' + f,
  ),
];
const fingerprint = async () =>
  Object.fromEntries(await Promise.all(files.map(async (f) => [f, sha(await readFile(f))])));
const metadata = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sources: await fingerprint(),
  parameterSourceSha256: parameter.sourceSha256,
  parameterPrototypeSha256: sha(parameter.code),
  packingWasmSha256: sha(packing),
  rustc: execFileSync(process.env.RUSTC ?? 'rustc', ['--version'], { encoding: 'utf8' }).trim(),
  packingBuild:
    'rustc --edition 2021 --crate-type cdylib --target wasm32-unknown-unknown -C opt-level=3 -C panic=abort -C target-feature=+simd128',
  hardware: {
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryGiB: totalmem() / 2 ** 30,
    release: release(),
  },
  frames,
  repetitions,
  workloads,
  kinds,
  dprs,
  grid: { cols: 240, rows: 80 },
  headless: true,
  method:
    'Isolated per-page route injection. Same real inputs, fonts and compositor. Every pipeline update submitted; GPU fences every 32 plus final. Warm 32 updates. Wasm packing includes raw-input/output copies. Stage loops are separate upper bounds, not terminal speed or physical display FPS. Adversarial parser fixtures run after timing. Three actual GPU images compared with canonical packing per workload/prototype; all eight packed frames checked for packing/fusion prototypes.',
  validation: {},
  results: [],
  errors: [],
};
const save = () => writeFile(`${output}/runs.json`, JSON.stringify(metadata, null, 2) + '\n');
await save();
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  for (const dpr of dprs)
    for (const workload of workloads) {
      const context = await browser.newContext({
        viewport: { width: 2600, height: 2100 },
        deviceScaleFactor: dpr,
      });
      let expectedInitial, expectedFinal, expectedPixels, expectedInputs;
      for (let repeat = 0; repeat < repetitions; repeat++) {
        let order = kinds.map((_, i) => kinds[(i + repeat) % kinds.length]);
        if (repeat % 2) order.reverse();
        for (const kind of order) {
          const page = await context.newPage(),
            errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          page.on('console', (m) => {
            if (m.type() === 'error') errors.push(m.text());
          });
          try {
            const useParams = ['params', 'combined', 'combined-simd', 'combined-fused'].includes(
              kind,
            );
            const usePrint = ['print', 'combined', 'combined-simd', 'combined-fused'].includes(
              kind,
            );
            if (useParams)
              await page.addInitScript({
                content: `(()=>{${parameter.code.replace('export function install', 'function install')}window.__parameterInstall=install;})();`,
              });
            if (usePrint)
              await page.addInitScript({ content: `window.__bulkPrint=${bulkPrint.toString()};` });
            await page.route('**/packages/wraith/src/xterm.ts*', async (route) => {
              const response = await route.fetch();
              let body = await response.text();
              assert(body.includes('accelerateInput(this);'), 'Unfamiliar Terminal constructor');
              body = body.replace(
                'accelerateInput(this);',
                'accelerateInput(this); window.__parameterInstall?.(this); window.__bulkPrint?.(this);',
              );
              await route.fulfill({ response, body });
            });
            if (
              ['wasm-scalar', 'wasm-simd', 'combined-simd', 'fused', 'combined-fused'].includes(
                kind,
              )
            )
              await page.route('**/packages/wraith/src/xterm-renderer.ts*', async (route) => {
                const response = await route.fetch();
                let body = await response.text();
                assert(
                  body.includes('let direct = words !== void 0 && !selectable;') ||
                    body.includes('let direct = words !== undefined && !selectable;'),
                  'Unfamiliar row packing loop',
                );
                const hook = `if(words !== undefined && !selectable && this.experimentalPackRow?.(words, values, y * packed, cols, c, brighten)) {
              rowWords.set(words.subarray(0,raw),y*raw); cached[y]=1; this.rowSources[y]=0xffffffff; stamps[y]=stamp; continue;
            }`;
                if (kind.includes('fused')) {
                  const match =
                    /if \(cached\[y\] && sameRow\(words, rowWords, y \* raw, raw\)\) continue;/;
                  assert(match.test(body), 'Unfamiliar row equality check');
                  body = body
                    .replace(
                      match,
                      `if(cached[y] && sameRow(words,rowWords,y*raw,raw)) {
                if(this.experimentalDirty?.[y]){this.rowSources[y]=0xffffffff;stamps[y]=stamp;} continue;
              }`,
                    )
                    .replaceAll(
                      'stamps[s] !== stamp',
                      'stamps[s] !== stamp && !this.experimentalDirty?.[s]',
                    );
                  body = body
                    .replace(
                      'this.pack(start, end);',
                      'this.pack(start, end); this.experimentalDirty?.fill(0);',
                    )
                    .replace(
                      'this.pack(0, this.terminal.rows - 1);',
                      'this.pack(0, this.terminal.rows - 1); this.experimentalDirty?.fill(0);',
                    );
                } else
                  body = body.replace(
                    /let direct = words !== (?:void 0|undefined) && !selectable;/,
                    hook + 'let direct = words !== undefined && !selectable;',
                  );
                await route.fulfill({ response, body });
              });
            await page.route('**/compare.js*', async (route) => {
              const response = await route.fetch();
              let body = await response.text();
              assert(body.includes('window.comparison = {'), 'Unfamiliar comparison exports');
              const helpers = `const researchInputFixtures=${inputFixtures.toString()};
              const researchPacking=${installPacking.toString()};const researchValidatePacking=${validatePacking.toString()};const researchStageCeiling=${stageCeiling.toString()};
              const researchFused=${installFused.toString()};const researchValidateFused=${validateFused.toString()};let fusedHook;\n`;
              body =
                helpers +
                body.replace(
                  'window.comparison = {',
                  `window.comparison = {
              researchInputs:()=>researchInputFixtures(WraithTerminal,XtermTerminal,()=>{}),
              researchWarm:async()=>{for(let i=0;i<32;i++){active.parse(active.inputs[i%8].bytes);active.draw();if((i+1)%32===0)await active.finish();}},
              researchPacking:(mode,bytes)=>researchPacking(active,mode,bytes),
              researchValidatePacking:()=>researchValidatePacking(active),
              researchFused:()=>{fusedHook=researchFused(active);},
              researchValidateFused:()=>researchValidateFused(active,fusedHook),
              researchStages:count=>researchStageCeiling(active,count),
              researchWords:()=>Array.from(active.renderer.staging),
              researchDrawVariant:async i=>{active.parse(active.inputs[i].bytes);active.draw();await active.finish();},
              researchCanonical:async()=>{const r=active.renderer,hook=r.experimentalPackRow;r.experimentalPackRow=undefined;r.full=true;active.draw();await active.finish();r.experimentalPackRow=hook;},
              researchInputsHash:async()=>Promise.all(active.inputs.map(async input=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',input.bytes)),v=>v.toString(16).padStart(2,'0')).join(''))),`,
                );
              await route.fulfill({ response, body });
            });
            await page.goto(`${base}/compare.html?type=wraith&workload=${workload}`);
            await page.waitForFunction(() => window.comparison?.ready, undefined, {
              timeout: 60000,
            });
            const setup = await page.evaluate(() => window.comparison.ready);
            assert(setup, await page.evaluate(() => window.failure));
            // Browser screenshots composite DOM over the canvas rectangle. Hide
            // xterm's fading 14px scrollbar overlay so it cannot masquerade as a
            // GPU pixel difference; terminal cells and canvas geometry stay intact.
            await page.addStyleTag({
              content: '.xterm-scrollable-element > .scrollbar { visibility: hidden !important; }',
            });
            metadata.userAgent ??= await page.evaluate(() => navigator.userAgent);
            metadata.adapter ??= await page.evaluate(() => window.comparison.adapterInfo());
            await page.evaluate(() => window.comparison.researchWarm());
            let packingValidation;
            if (['wasm-scalar', 'wasm-simd', 'combined-simd'].includes(kind)) {
              await page.evaluate(
                ([mode, bytes]) => window.comparison.researchPacking(mode, bytes),
                [kind === 'wasm-scalar' ? 'wasm-scalar' : 'wasm-simd', Array.from(packing)],
              );
              packingValidation = await page.evaluate(() =>
                window.comparison.researchValidatePacking(),
              );
            }
            if (kind.includes('fused')) {
              await page.evaluate(() => window.comparison.researchFused());
              packingValidation = await page.evaluate(() =>
                window.comparison.researchValidateFused(),
              );
            }
            // Reset to the same first fixture after correctness checks/warmup.
            await page.evaluate(() =>
              window.comparison.fixture({
                data: new TextDecoder().decode(
                  window.comparison.workload(
                    240,
                    80,
                    0,
                    new URLSearchParams(location.search).get('workload'),
                  ).bytes,
                ),
              }),
            );
            const initial = sha(await page.evaluate(() => window.comparison.text()));
            expectedInitial ??= initial;
            assert.equal(initial, expectedInitial, 'Initial text changed');
            const inputHashes = await page.evaluate(() => window.comparison.researchInputsHash());
            expectedInputs ??= inputHashes;
            assert.deepEqual(inputHashes, expectedInputs, 'Workload bytes changed');
            // Packed data checks every foreground/background/style/glyph word,
            // including fallback rows. The existing GPU compositor is unchanged.
            const words = sha(
              JSON.stringify(await page.evaluate(() => window.comparison.researchWords())),
            );
            expectedPixels ??= words;
            assert.equal(words, expectedPixels, 'Initial GPU cell words changed');
            const result = await page.evaluate(
              (frames) =>
                window.comparison.run({
                  type: 'wraith',
                  workload: new URLSearchParams(location.search).get('workload'),
                  cols: 240,
                  rows: 80,
                  frames,
                }),
              frames,
            );
            assert.equal(result.submittedFrames, frames);
            assert(result.gpuFenced);
            const final = sha(await page.evaluate(() => window.comparison.text()));
            expectedFinal ??= final;
            assert.equal(final, expectedFinal, 'Final text changed');
            let stages;
            if (kind === 'baseline' && repeat === 0)
              stages = await page.evaluate(
                (count) => window.comparison.researchStages(count),
                Math.max(frames, 1024),
              );
            const visual = [];
            if (repeat === 0)
              for (const variant of [0, 3, 7]) {
                await page.evaluate((i) => window.comparison.researchDrawVariant(i), variant);
                const actualPng = await page.locator('.wraith-xterm-webgpu').screenshot();
                const actual = pixels(actualPng);
                await page.evaluate(() => window.comparison.researchCanonical());
                const expectedPng = await page.locator('.wraith-xterm-webgpu').screenshot();
                const expected = pixels(expectedPng);
                assert.equal(actual.width, expected.width);
                assert.equal(actual.height, expected.height);
                const actualHash = sha(actual.data),
                  expectedHash = sha(expected.data);
                if (actualHash !== expectedHash) {
                  await writeFile(
                    `.cache/performance-experiments/${workload}-${kind}-${variant}-actual.png`,
                    actualPng,
                  );
                  await writeFile(
                    `.cache/performance-experiments/${workload}-${kind}-${variant}-expected.png`,
                    expectedPng,
                  );
                }
                assert.equal(
                  actualHash,
                  expectedHash,
                  'Actual GPU pixels differ from canonical packing',
                );
                visual.push({
                  variant,
                  width: actual.width,
                  height: actual.height,
                  pixelsSha256: actualHash,
                  byteIdentical: true,
                });
              }
            // Run the adversarial parser corpus after timing, so custom Unicode
            // providers and malformed input do not pollute the timed IC/JIT state.
            if (!metadata.validation[kind])
              metadata.validation[kind] = await page.evaluate(() =>
                window.comparison.researchInputs(),
              );
            assert.deepEqual(errors, []);
            const row = {
              kind,
              workload,
              dpr,
              repeat,
              inputHashes,
              initialTextSha256: initial,
              finalTextSha256: final,
              initialGpuWordsSha256: words,
              packingValidation,
              visual,
              stages,
              ...result,
            };
            metadata.results.push(row);
            await save();
            console.log(
              `${workload} DPR${dpr} ${kind} #${repeat + 1}: ${result.pipelineUpdatesPerSecond.toFixed(1)} GPU-completed updates/s; parse ${result.parseMs.mean.toFixed(3)}ms; redraw ${result.renderAndLayoutMs.mean.toFixed(3)}ms`,
            );
          } catch (error) {
            metadata.errors.push({ kind, workload, dpr, repeat, error: String(error), errors });
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
assert.deepEqual(await fingerprint(), metadata.sources, 'Sources changed during experiment batch');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const groups = [];
for (const dpr of dprs)
  for (const workload of workloads)
    for (const kind of kinds) {
      const runs = metadata.results.filter(
        (r) => r.kind === kind && r.workload === workload && r.dpr === dpr,
      );
      const control = metadata.results.filter(
        (r) => r.kind === 'baseline' && r.workload === workload && r.dpr === dpr,
      );
      const rates = runs.map((r) => r.pipelineUpdatesPerSecond),
        rate = median(rates);
      groups.push({
        kind,
        workload,
        dpr,
        updatesPerSecond: rate,
        range: [Math.min(...rates), Math.max(...rates)],
        ratioToBaseline: control.length
          ? rate / median(control.map((r) => r.pipelineUpdatesPerSecond))
          : null,
        parseMeanMs: median(runs.map((r) => r.parseMs.mean)),
        redrawMeanMs: median(runs.map((r) => r.renderAndLayoutMs.mean)),
      });
    }
await writeFile(
  `${output}/summary.json`,
  JSON.stringify({ date: metadata.date, repetitions, frames, groups }, null, 2) + '\n',
);
console.log(
  `Saved ${metadata.results.length} runs; all input state and GPU cell data checks passed.`,
);
