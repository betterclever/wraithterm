// Wraith vs wterm vs xterm.js, headed so frames follow the real display. For
// each scenario, rotates the renderer order across rounds; a fresh browser per
// run. Records frames per terminal per second, mount time, lost WebGL contexts,
// the display's idle rate after each run, and the package versions under test.
// Run alone, on a quiet machine.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const out = resolve(root, process.env.OUT ?? 'docs/benchmarks/rivals');
const rounds = Number(process.env.ROUNDS ?? 3),
  seconds = Number(process.env.SECONDS ?? 8);
const doom = process.env.DOOM; // recorded doomterm Kitty stream (local file), optional
const all = {
  single: {
    count: 1,
    cols: 160,
    rows: 50,
    workload: 'halfblock',
    types: ['wraith', 'wterm', 'wterm-ghostty', 'webgl'],
  },
  wall: {
    count: 16,
    cols: 80,
    rows: 24,
    workload: 'halfblock',
    types: ['wraith', 'wterm', 'wterm-ghostty', 'webgl'],
  },
  agents: {
    count: 64,
    cols: 80,
    rows: 24,
    workload: 'logs',
    types: ['wraith', 'wterm', 'wterm-ghostty', 'webgl'],
  },
  ...(doom && {
    doom: {
      count: 1,
      cols: 160,
      rows: 45,
      workload: '/@fs' + resolve(doom),
      types: ['wraith', 'wterm-ghostty'],
    },
  }),
};
const scenarios = (process.env.SCENARIOS ?? Object.keys(all).join(',')).split(',');
const runs = [];
let userAgent;
for (let round = 0; round < rounds; round++)
  for (const name of scenarios) {
    const s = all[name];
    for (let k = 0; k < s.types.length; k++) {
      const type = s.types[(k + round) % s.types.length];
      const browser = await chromium.launch({
        executablePath:
          process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: process.env.HEADED !== '1',
        args: ['--window-position=0,0', '--enable-unsafe-webgpu'],
      });
      const page = await browser.newPage({
        viewport: { width: 1600, height: 900 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/compare.html');
      const result = await page
        .evaluate(
          async ([m, a]) => (await import(m)).run(...a),
          ['/rival-bench.js', [type, s.count, s.cols, s.rows, s.workload, seconds]],
        )
        .catch((e) => ({ failed: String(e.message ?? e).slice(0, 200) }));
      const displayHz = await page
        .evaluate(
          () =>
            new Promise((done) => {
              let n = 0;
              const t = performance.now();
              const f = () =>
                ++n && performance.now() - t < 1000
                  ? requestAnimationFrame(f)
                  : done((n / (performance.now() - t)) * 1000);
              requestAnimationFrame(f);
            }),
        )
        .catch(() => 0);
      userAgent ??= await page.evaluate(() => navigator.userAgent);
      // SHOTS=1 keeps a screenshot of each run's final frame, to check output.
      if (process.env.SHOTS === '1')
        await page.screenshot({ path: resolve(out, `${round}-${name}-${type}.png`) });
      await browser.close();
      if (errors.length && !result.failed) result.pageErrors = errors.slice(0, 3);
      const run = { round, scenario: name, type, ...result, displayHz: Math.round(displayHz) };
      runs.push(run);
      console.log(
        result.failed
          ? `${round} ${name} ${type}: FAILED ${result.failed}`
          : `${round} ${name} ${type}: ${result.meanFps.toFixed(1)} fps/terminal (p10 ${result.p10Fps.toFixed(1)}), mount ${result.mountMs.toFixed(0)} ms, lost ${result.lostContexts}, ${run.displayHz} Hz${run.pageErrors ? ' ERR ' + run.pageErrors[0] : ''}`,
      );
    }
  }
const version = async (p) =>
  JSON.parse(await readFile(resolve(root, 'node_modules', p, 'package.json'), 'utf8')).version;
const sha = async (f) =>
  createHash('sha256')
    .update(await readFile(resolve(root, f)))
    .digest('hex');
const summary = {};
for (const name of scenarios)
  for (const type of all[name].types) {
    const r = runs.filter((x) => x.scenario === name && x.type === type && !x.failed);
    summary[`${name} ${type}`] = r.length
      ? {
          fps: [Math.min(...r.map((x) => x.meanFps)), Math.max(...r.map((x) => x.meanFps))],
          lostContexts: Math.max(...r.map((x) => x.lostContexts)),
        }
      : { failed: true };
  }
await mkdir(out, { recursive: true });
await writeFile(
  resolve(out, 'results.json'),
  JSON.stringify(
    {
      measured: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      versions: {
        '@wterm/dom': await version('@wterm/dom'),
        '@wterm/ghostty': await version('@wterm/ghostty'),
        '@xterm/xterm': await version('@xterm/xterm'),
        '@xterm/addon-webgl': await version('@xterm/addon-webgl'),
        wraithterm: JSON.parse(
          await readFile(resolve(root, 'packages/wraith/package.json'), 'utf8'),
        ).version,
      },
      sources: Object.fromEntries(
        await Promise.all(
          [
            'packages/wraith/wasm/wraith_engine_bg.wasm',
            'demo/rival-bench.js',
            'scripts/rival-benchmark.mjs',
          ].map(async (f) => [f, await sha(f)]),
        ),
      ),
      browser: userAgent,
      cpu: cpus()[0]?.model,
      headed: process.env.HEADED === '1',
      scenarios: Object.fromEntries(
        scenarios.map((n) => [
          n,
          {
            ...all[n],
            workload: all[n].workload.startsWith('/@fs')
              ? 'recorded doomterm Kitty stream (640x400 RGB, Freedoom demo1)'
              : all[n].workload,
          },
        ]),
      ),
      method:
        '1600x900 window at DPR 2; each terminal writes its next update after the previous one is processed and a display frame passes. Wraith and xterm.js frames are their render callbacks (capped by updates written); wterm frames are completed write-and-frame cycles, because it renders on the main thread in its own animation frame. Wraith uses a 4-worker pool when several terminals share the page.',
      summary,
      runs,
    },
    null,
    2,
  ) + '\n',
);
console.log(summary);
