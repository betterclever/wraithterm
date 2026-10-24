// Many terminals in one tab, headed so frames follow the real display (e.g. 120 Hz).
// For each count, compares pooled Wraith (4 workers), dedicated Wraith (one
// worker each) and xterm.js + WebGL, in rotating order; one page per run. Records
// mount time, frames shown per terminal per second, lost WebGL contexts, the
// display's idle frame rate after the run, and Chrome's summed process memory.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const counts = (process.env.COUNTS ?? '16,64,128').split(',').map(Number);
const types = ['pooled', 'dedicated', 'webgl'];
const rounds = Number(process.env.ROUNDS ?? 3),
  seconds = Number(process.env.SECONDS ?? 8);
const out = resolve(root, process.env.OUT ?? 'docs/benchmarks/pool');

function memoryMiB(marker) {
  const main = execFileSync('/bin/ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' })
    .split('\n')
    .find((l) => l.includes(marker) && !l.includes('--type='));
  const pid = Number(main?.trim().split(/\s+/)[0]);
  // Sum resident memory of the browser process and all descendants.
  const table = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [p, pp] of table) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  const rss = new Map(table.map(([p, , r]) => [p, r]));
  let total = 0;
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    total += rss.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return total / 1024;
}

const runs = [];
let userAgent;
for (let round = 0; round < rounds; round++)
  for (const count of counts)
    for (let k = 0; k < types.length; k++) {
      const type = types[(k + round) % types.length];
      // A fresh browser per run, so memory belongs to this run alone.
      const browser = await chromium.launch({
        executablePath:
          process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: process.env.HEADED !== '1',
        args: [
          '--window-position=0,0',
          '--enable-unsafe-webgpu',
          `--wraith-bench=${process.pid}-${runs.length}`,
        ],
      });
      const page = await browser.newPage({
        viewport: { width: 1600, height: 900 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/compare.html');
      await page.evaluate((n) => (window.POOL_WORKERS = n), Number(process.env.POOL_WORKERS ?? 4));
      const pending = page
        .evaluate(
          async ([m, t, n, s]) => (await import(m)).run(t, n, s),
          ['/pool-bench.js', type, count, seconds],
        )
        .catch((e) => ({
          failed: String(e.message ?? e).slice(0, 200),
          mountMs: NaN,
          meanFps: 0,
          p10Fps: 0,
          minFps: 0,
          lostContexts: 0,
        }));
      // Sample memory mid-measurement.
      await page.waitForTimeout((2 + seconds / 2) * 1000);
      const memory = memoryMiB(`--wraith-bench=${process.pid}-${runs.length}`);
      const result = await pending;
      const displayHz = await page.evaluate(
        () =>
          new Promise((done) => {
            let n = 0;
            const s = performance.now();
            const tick = () =>
              ++n && performance.now() - s < 1000
                ? requestAnimationFrame(tick)
                : done((n / (performance.now() - s)) * 1000);
            requestAnimationFrame(tick);
          }),
      );
      userAgent ??= await page.evaluate(() => navigator.userAgent);
      await browser.close();
      if (errors.length && !result.failed)
        throw new Error(`${type} ${count}: ${errors.join('; ')}`);
      const run = {
        round,
        count,
        type,
        ...result,
        memoryMiB: Math.round(memory),
        displayHz: Math.round(displayHz),
      };
      runs.push(run);
      console.log(
        result.failed
          ? `${round} ${count} ${type}: FAILED ${result.failed}`
          : `${round} ${count} ${type}: mount ${result.mountMs.toFixed(0)} ms, ${result.meanFps.toFixed(1)} fps/terminal (p10 ${result.p10Fps.toFixed(1)}), lost ${result.lostContexts}, ${run.memoryMiB} MiB, ${run.displayHz} Hz`,
      );
    }
const sha = async (f) =>
  createHash('sha256')
    .update(await readFile(resolve(root, f)))
    .digest('hex');
const summary = {};
for (const count of counts)
  for (const type of types) {
    const all = runs.filter((x) => x.count === count && x.type === type);
    const r = all.filter((x) => !x.failed);
    if (!r.length) {
      summary[`${count} ${type}`] = { failed: all.map((x) => x.failed) };
      continue;
    }
    const range = (key) => [Math.min(...r.map((x) => x[key])), Math.max(...r.map((x) => x[key]))];
    summary[`${count} ${type}`] = {
      meanFps: range('meanFps'),
      p10Fps: range('p10Fps'),
      mountMs: range('mountMs'),
      memoryMiB: range('memoryMiB'),
      lostContexts: range('lostContexts'),
    };
  }
await mkdir(out, { recursive: true });
await writeFile(
  resolve(out, 'results.json'),
  JSON.stringify(
    {
      measured: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      sources: Object.fromEntries(
        await Promise.all(
          [
            'packages/wraith/wasm/wraith_engine_bg.wasm',
            'packages/wraith/src/pool.ts',
            'packages/wraith/src/worker.ts',
            'demo/pool-bench.js',
            'scripts/pool-benchmark.mjs',
          ].map(async (f) => [f, await sha(f)]),
        ),
      ),
      browser: userAgent,
      cpu: cpus()[0]?.model,
      headed: process.env.HEADED === '1',
      method: {
        terminals: '80x24 each, in a grid filling 1600x900 at DPR 2',
        update: 'two colored log lines plus a rewritten status row per update',
        pacing:
          'next update after the previous is processed and a display frame passes; native also waits for flush (GPU fence)',
        seconds,
        warm: 2,
        memory: 'summed RSS of the browser and all its processes, sampled mid-measurement',
        note: 'frames shown per terminal per second; xterm.js WebGL terminals beyond the browser context limit lose their renderer (lostContexts) and stop drawing while their writes still complete',
      },
      summary,
      runs,
    },
    null,
    2,
  ) + '\n',
);
console.log(summary);
