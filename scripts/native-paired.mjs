import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const cache = join(root, '.cache/native-pass');
const baseline = resolve(
  root,
  process.env.WRAITH_NATIVE_BASELINE ?? '.cache/native-pass/baseline/wasm',
);
const candidate = resolve(root, process.env.WRAITH_NATIVE_CANDIDATE ?? 'packages/wraith/wasm');
const output = resolve(root, process.env.WRAITH_REPORT_DIR ?? '.cache/native-pass/paired');
const pairs = Number(process.env.WRAITH_PAIRS ?? 20);
const frames = Number(process.env.WRAITH_FRAMES ?? 128);
const dpr = Number(process.env.WRAITH_DPR ?? 1);
const history = Number(process.env.WRAITH_HISTORY ?? 2000);
assert([1, 2].includes(dpr));
assert(Number.isInteger(history) && history >= 0 && history <= 100000);
const stages = (process.env.WRAITH_STAGES ?? 'parse,pipeline').split(',');
const workloads = (process.env.WRAITH_WORKLOADS ?? 'complex,churn,showcase,pipes,append').split(
  ',',
);
assert(Number.isInteger(pairs) && pairs >= 10 && pairs <= 100);
assert(Number.isInteger(frames) && frames >= 32 && frames <= 2048 && frames % 32 === 0);
assert(stages.every((s) => ['parse', 'pipeline'].includes(s)));
assert(workloads.every((s) => ['complex', 'churn', 'showcase', 'pipes', 'append'].includes(s)));
const sha = (data) => createHash('sha256').update(data).digest('hex');
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });
const source = await readFile(join(root, 'demo/compare.js'), 'utf8');
const start = source.indexOf('const encoder =');
const end = source.indexOf('let wasmReady;');
assert(start > 0 && end > start);
await writeFile(
  join(cache, 'workloads.js'),
  "import {showcase} from '/demo/showcase.js';\nimport {pipesWorkload} from '/demo/pipes-scene.js';\n" +
    source.slice(start, end) +
    '\nexport {workload};\n',
);
await writeFile(
  join(cache, 'index.html'),
  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="margin:0;background:#101824"></body></html>',
);
const paths = [
  ...(process.env.WRAITH_EXTRA_SOURCES ?? '').split(',').filter(Boolean),
  'scripts/native-paired.mjs',
  'scripts/build-engine.mjs',
  'scripts/ghostty-patches.mjs',
  'scripts/ghostty-cell-layout.mjs',
  'native/abi-probe.c',
  'native/cell-layout-test.c',
  'native/bridge.c',
  'native/patches/batch-sgr.patch',
  'native/patches/batch-sgr.json',
  'upstream.json',
  'crates/wraith-engine/src/gpu.rs',
  'crates/wraith-engine/src/web.rs',
  'crates/wraith-engine/src/core.rs',
  'demo/compare.js',
  'demo/showcase.js',
  'demo/pipes-scene.js',
  'demo/fonts/JetBrainsMono-Regular.ttf',
  'packages/wraith/wasm/wraith_engine.js',
  'packages/wraith/wasm/wraith_engine_bg.wasm',
  relative(root, join(candidate, 'wraith_engine.js')),
  relative(root, join(candidate, 'wraith_engine_bg.wasm')),
  relative(root, join(baseline, 'wraith_engine.js')),
  relative(root, join(baseline, 'wraith_engine_bg.wasm')),
];
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(paths.map(async (p) => [p, sha(await readFile(join(root, p)))])),
  );
const data = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sources: await fingerprints(),
  hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  settings: {
    pairs,
    frames,
    warmup: 128,
    cols: 240,
    rows: 80,
    dpr,
    scrollback: history,
    stages,
    workloads,
  },
  method:
    'Two isolated Wasm instances of the pinned before/after artifacts in one browser page. Alternate baseline/candidate blocks. Pipeline counts and fences every GPU submission in groups of 32; parse-only submits none. Same UTF-8 bytes, font and geometry. Not presentation FPS. Input generation and state validation excluded.',
  results: [],
  errors: [],
};
const save = () => writeFile(join(output, 'runs.json'), JSON.stringify(data, null, 2) + '\n');
await save();
const server = await createServer({
  configFile: false,
  root,
  cacheDir: join(cache, 'vite'),
  server: { host: '127.0.0.1', port: 5198, strictPort: true },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const probe = await browser.newPage();
  await probe.goto('http://127.0.0.1:5198/.cache/native-pass/index.html');
  data.gpuProbe = await probe.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const info = adapter.info;
    return {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      isFallbackAdapter: info.isFallbackAdapter,
    };
  });
  assert(data.gpuProbe && data.gpuProbe.isFallbackAdapter === false, 'Hardware GPU required');
  await probe.close();
  await save();
  for (const workload of workloads)
    for (const stage of stages) {
      const page = await browser.newPage({
        viewport: { width: 2400, height: 1800 },
        deviceScaleFactor: dpr,
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('http://127.0.0.1:5198/.cache/native-pass/index.html');
      const systemLoadBefore = loadavg();
      const result = await page.evaluate(
        async (config) => {
          const modules = await Promise.all([import(config.before), import(config.after)]);
          await Promise.all(modules.map((m) => m.default()));
          const { workload } = await import('/.cache/native-pass/workloads.js');
          const font = new Uint8Array(
            await (await fetch('/demo/fonts/JetBrainsMono-Regular.ttf')).arrayBuffer(),
          );
          const inputs = Array.from(
            { length: 8 },
            (_, i) => workload(240, 80, i, config.workload).bytes,
          );
          const terms = [];
          for (const m of modules) {
            if (config.stage === 'parse') terms.push(new m.Headless(240, 80, config.history));
            else {
              const canvas = document.createElement('canvas');
              document.body.append(canvas);
              canvas.style.width = '2160px';
              canvas.style.height = '1600px';
              const offscreen = canvas.transferControlToOffscreen();
              const e = await m.Engine.create(
                offscreen,
                font,
                240,
                80,
                15 * config.dpr,
                20 / 15,
                config.history,
              );
              if (
                e.cell_width !== 9 * config.dpr ||
                e.cell_height !== 20 * config.dpr ||
                offscreen.width !== 2160 * config.dpr ||
                offscreen.height !== 1600 * config.dpr
              )
                throw Error(
                  `Native geometry differs: ${e.cell_width}x${e.cell_height}, ${offscreen.width}x${offscreen.height}`,
                );
              e.theme(0xf5ebdf, 0x241810, 0xf5ebdf);
              terms.push(e);
            }
          }
          const text = (t) => (config.stage === 'parse' ? t.text() : t.text(false));
          const finish = (t) => (config.stage === 'pipeline' ? t.fence() : Promise.resolve());
          const draw = (t) => {
            if (config.stage === 'pipeline' && !t.render(0, true))
              throw Error('Missing GPU submission');
          };
          for (const t of terms) {
            for (let i = 0; i < 128; i++) {
              t.write(inputs[i % 8]);
              draw(t);
              if ((i + 1) % 32 === 0) await finish(t);
            }
            await finish(t);
          }
          if (text(terms[0]) !== text(terms[1])) throw Error('Warmup terminal text differs');
          const samples = [];
          for (let pair = 0; pair < config.pairs; pair++)
            for (const k of pair % 2 ? [1, 0] : [0, 1]) {
              const t = terms[k],
                before = config.stage === 'pipeline' ? Number(t.metrics()[0]) : 0;
              let parseMs = 0,
                renderMs = 0;
              const started = performance.now();
              for (let i = 0; i < config.frames; i++) {
                const a = performance.now();
                t.write(inputs[i % 8]);
                const b = performance.now();
                draw(t);
                const c = performance.now();
                parseMs += b - a;
                renderMs += c - b;
                if (config.stage === 'pipeline' && (i + 1) % 32 === 0) await finish(t);
              }
              if (config.stage === 'pipeline') await finish(t);
              const elapsedMs = performance.now() - started;
              const submissions = config.stage === 'pipeline' ? Number(t.metrics()[0]) - before : 0;
              if (submissions !== (config.stage === 'pipeline' ? config.frames : 0))
                throw Error('Submission count differs');
              samples.push({
                pair,
                kind: k ? 'candidate' : 'baseline',
                elapsedMs,
                updatesPerSecond: (config.frames * 1000) / elapsedMs,
                parseMs,
                renderMs,
                submissions,
              });
            }
          const final = terms.map(text);
          if (final[0] !== final[1]) throw Error('Final terminal text differs');
          const hash = async (bytes) =>
            Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
              .map((x) => x.toString(16).padStart(2, '0'))
              .join('');
          const inputHashes = await Promise.all(inputs.map(hash));
          const textSha256 = await hash(new TextEncoder().encode(final[0]));
          const adapter = config.stage === 'pipeline' ? terms[0].adapter : undefined;
          terms.forEach((t) => t.free());
          return { samples, inputHashes, textSha256, adapter, userAgent: navigator.userAgent };
        },
        {
          before: '/@fs' + join(baseline, 'wraith_engine.js'),
          after: '/@fs' + join(candidate, 'wraith_engine.js'),
          workload,
          stage,
          pairs,
          frames,
          dpr,
          history,
        },
      );
      assert.deepEqual(errors, []);
      data.results.push({
        workload,
        stage,
        systemLoadBefore,
        systemLoadAfter: loadavg(),
        ...result,
      });
      await save();
      await page.close();
      console.log(`${workload} ${stage}: ${pairs} pairs completed`);
    }
} catch (e) {
  data.errors.push(String(e));
  await save();
  throw e;
} finally {
  await browser.close();
  await server.close();
}
assert.deepEqual(await fingerprints(), data.sources, 'Sources changed during timing');
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const summary = data.results.map((r) => {
  const before = r.samples.filter((x) => x.kind === 'baseline'),
    after = r.samples.filter((x) => x.kind === 'candidate');
  const ratios = after
    .map((x, i) => x.updatesPerSecond / before[i].updatesPerSecond)
    .sort((a, b) => a - b);
  return {
    workload: r.workload,
    stage: r.stage,
    baseline: median(before.map((x) => x.updatesPerSecond)),
    candidate: median(after.map((x) => x.updatesPerSecond)),
    pairedRatio: median(ratios),
    p10: ratios[Math.floor(ratios.length * 0.1)],
    p90: ratios[Math.floor(ratios.length * 0.9)],
  };
});
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
