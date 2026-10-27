// GPU cost of each post-process effect: fenced terminal updates per second at
// 160x50, DPR 2, through the public benchmark() path (parse + pack + submit +
// scene pass + effect passes, with a GPU fence every 32 submissions). Also
// counts display-driven animation frames for an iTime shader. Configurations
// are interleaved across rounds so drift affects every configuration alike.
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';

const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const output = process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/gpu-effects';
const rounds = Number(process.env.ROUNDS ?? 3);
const frames = Number(process.env.FRAMES ?? 512);
const headed = process.env.HEADED === '1';
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const shaders = {
  amber: await read('demo/effects/amber.wgsl'),
  glitch: await read('demo/effects/glitch.wgsl'),
};
const configs = {
  off: null,
  crt: { crt: true },
  bloom: { bloom: 0.6 },
  cursorTrail: { cursorTrail: true },
  'crt+bloom+trail': { crt: true, bloom: 0.6, cursorTrail: true },
  'shader:amber': { shader: shaders.amber },
  'shader:glitch': { shader: shaders.glitch, animate: false },
  'all+shader:amber': { crt: true, bloom: 0.6, cursorTrail: true, shader: shaders.amber },
};
const wasm = await readFile(
  new URL('../packages/wraith/wasm/wraith_engine_bg.wasm', import.meta.url),
);
const meta = {
  date: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty:
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
    }).trim() !== '',
  wasmSha256: createHash('sha256').update(wasm).digest('hex'),
  cpu: cpus()[0]?.model,
  platform: `${process.platform} ${process.arch}`,
  headless: !headed,
  grid: '160x50',
  dpr: 2,
  framesPerRun: frames,
  rounds,
};
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: !headed,
});
const runs = [];
let animation;
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  await page.goto(`${base}/playground.html`);
  await page.waitForFunction(() => window.wraith);
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:1580px;height:980px;z-index:10000';
    document.body.append(host);
    window.bench = await window.wraith.constructor.mount(host, {
      cols: 160,
      rows: 50,
      fit: false,
      fontSize: 9,
    });
    window.benchRenders = 0;
    window.bench.onRender(() => window.benchRenders++);
  });
  Object.assign(meta, await page.evaluate(() => ({ userAgent: navigator.userAgent })));
  for (let round = 0; round < rounds; round++)
    for (const [name, effects] of Object.entries(configs))
      for (const workload of ['sparse', 'dense']) {
        const result = await page.evaluate(
          async ({ effects, workload, frames }) => {
            const term = window.bench;
            await term.setEffects(effects);
            await term.flush();
            const r = await term.benchmark({ workload, frames, warmup: 64 });
            return {
              ...r,
              canvas: [term.canvas.width, term.canvas.height],
              cellPixels: [term.cellWidth, term.cellHeight],
            };
          },
          { effects, workload, frames },
        );
        runs.push({ round, config: name, ...result });
        console.log(
          `${round} ${name.padEnd(18)} ${workload.padEnd(6)} ${result.fencedFramesPerSecond.toFixed(0).padStart(6)} updates/s  cpu p50 ${result.cpuP50Ms.toFixed(3)} ms`,
        );
      }
  meta.adapter = runs[0]?.adapter;
  meta.canvas = runs[0]?.canvas;
  // Display-driven animation: requestAnimationFrame submissions in 3 s while an
  // iTime shader animates over a static terminal (post pass only).
  animation = await page.evaluate(async (source) => {
    const term = window.bench;
    await term.setEffects(null);
    await term.write('\x1b[2J\x1b[Hstatic content\r\n');
    await term.flush();
    const count = async (ms) => {
      const start = window.benchRenders;
      await new Promise((r) => setTimeout(r, ms));
      return window.benchRenders - start;
    };
    const idleOff = await count(1000);
    await term.setEffects({ shader: source });
    const animated = await count(3000);
    await term.setEffects({ crt: true, bloom: 0.6 });
    await term.flush();
    const idleStatic = await count(1000);
    await term.setEffects(null);
    return {
      idleFramesPerSecondEffectsOff: idleOff,
      animatedShaderFramesPerSecond: animated / 3,
      idleFramesPerSecondStaticEffects: idleStatic,
    };
  }, shaders.glitch);
  console.log(animation);
} finally {
  await browser.close();
}
const summary = {};
for (const run of runs) {
  const key = `${run.config}/${run.workload}`;
  (summary[key] ??= []).push(run.fencedFramesPerSecond);
}
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const table = Object.fromEntries(
  Object.entries(summary).map(([key, values]) => [
    key,
    { medianUpdatesPerSecond: median(values), msPerUpdate: 1000 / median(values), values },
  ]),
);
await mkdir(output, { recursive: true });
const file = `${output}/chrome-${headed ? 'headed' : 'headless'}-dpr2.json`;
await writeFile(file, JSON.stringify({ meta, animation, summary: table, runs }, null, 2) + '\n');
console.log(`Wrote ${file}`);
