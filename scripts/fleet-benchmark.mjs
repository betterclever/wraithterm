// Fleet benchmark: shared-surface pool vs per-canvas pool at 64/256/1000
// terminals streaming agent logs (demo/fleet.html). Run headed so animation
// frames follow the real display, and keep the display awake (an idle-dimmed
// display drops Chrome to 30 Hz):
//   HEADED=1 WRAITH_URL=http://127.0.0.1:5173 caffeinate -u -d npm run benchmark:fleet
// COUNTS, ROUNDS, SECONDS, WARM, OUT, RESULTS (file name), MODES (shared,canvas),
// FEEDS (main,worker: shared only), WORKERS and BUILD (label of the served
// build when it differs from this checkout) override the defaults.
// Each run uses a fresh browser; configurations alternate order per round.
// Reports, per measurement window: display frames (main-thread rAF),
// per-terminal updates parsed, per-terminal frames submitted, GPU-completed
// terminal updates and presented surface frames (shared only), main-thread long
// tasks, browser memory and CPU, machine load average and power source.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const counts = (process.env.COUNTS ?? '64,256,1000').split(',').map(Number);
// Surface modes, and for shared surfaces where each terminal's stream is
// produced: 'main' (a main-thread driver calling write()) or 'worker' (each
// pool worker generates its terminals' stream itself; nothing crosses the
// main thread). Every mode/feed pair is one configuration.
const configs = (process.env.MODES ?? 'shared,canvas').split(',').flatMap((mode) =>
  (mode === 'shared' ? (process.env.FEEDS ?? 'main').split(',') : ['main']).map((feed) => ({
    mode,
    feed,
  })),
);
const workers = Number(process.env.WORKERS ?? 4);
const rounds = Number(process.env.ROUNDS ?? 3),
  seconds = Number(process.env.SECONDS ?? 8),
  warm = Number(process.env.WARM ?? 3);
const out = resolve(root, process.env.OUT ?? 'docs/benchmarks/fleet');

/** Summed RSS (MiB) and CPU time (s) of the browser and all its processes. */
function usage(marker) {
  const main = execFileSync('/bin/ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' })
    .split('\n')
    .find((l) => l.includes(marker) && !l.includes('--type='));
  const pid = Number(main?.trim().split(/\s+/)[0]);
  const table = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,rss=,time='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/));
  const seconds = (time) =>
    time
      .split(':')
      .map(Number)
      .reduce((a, b) => a * 60 + b, 0);
  const kids = new Map();
  for (const [p, pp] of table) kids.set(+pp, [...(kids.get(+pp) ?? []), +p]);
  const rows = new Map(table.map(([p, , r, t]) => [+p, { rss: +r, cpu: seconds(t) }]));
  let rss = 0,
    cpu = 0;
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    rss += rows.get(p)?.rss ?? 0;
    cpu += rows.get(p)?.cpu ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return { memoryMiB: rss / 1024, cpuSeconds: cpu };
}
const sum = (values) => values.reduce((a, b) => a + b, 0);
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
};

const runs = [];
let userAgent;
for (let round = 0; round < rounds; round++)
  for (const count of counts)
    for (let k = 0; k < configs.length; k++) {
      const { mode, feed } = configs[(k + round) % configs.length];
      const marker = `--wraith-fleet=${process.pid}-${runs.length}`;
      const browser = await chromium.launch({
        executablePath:
          process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: process.env.HEADED !== '1',
        args: ['--window-position=0,0', marker],
      });
      const page = await browser.newPage({
        viewport: { width: 1600, height: 900 },
        deviceScaleFactor: 2,
      });
      page.setDefaultTimeout(240_000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      let run = { round, count, mode, feed, workers };
      try {
        await page.goto(`${base}/fleet.html?auto=0`);
        await page.waitForFunction(() => window.fleet);
        const mounted = await page.evaluate((options) => window.fleet.start(options), {
          count,
          mode,
          feed,
          workers,
        });
        await page.waitForTimeout(warm * 1000);
        const loadBefore = loadavg();
        const a = await page.evaluate(() => window.fleet.metrics());
        const cpuA = usage(marker).cpuSeconds,
          wallA = performance.now();
        await page.waitForTimeout((seconds / 2) * 1000);
        const memory = usage(marker).memoryMiB;
        await page.waitForTimeout((seconds / 2) * 1000);
        const b = await page.evaluate(() => window.fleet.metrics());
        const cpuB = usage(marker).cpuSeconds,
          wallB = performance.now();
        const loadAfter = loadavg();
        const power = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' })
          .split('\n')[0]
          .replace(/^Now drawing from /, '')
          .replace(/'/g, '');
        const s = (b.time - a.time) / 1000;
        const perTerminal = b.acked.map((v, i) => (v - a.acked[i]) / s);
        const submitted = b.rendered.map((v, i) => (v - a.rendered[i]) / s);
        await page.evaluate(() => window.fleet.stop());
        const idleHz = await page.evaluate(
          () =>
            new Promise((done) => {
              let n = 0;
              const t0 = performance.now();
              const tick = () =>
                ++n && performance.now() - t0 < 1000
                  ? requestAnimationFrame(tick)
                  : done((n / (performance.now() - t0)) * 1000);
              requestAnimationFrame(tick);
            }),
        );
        userAgent ??= await page.evaluate(() => navigator.userAgent);
        run = {
          ...run,
          mountMs: Math.round(mounted.mountMs),
          seconds: s,
          displayFps: (b.frames - a.frames) / s,
          updatesPerTerminal: sum(perTerminal) / count,
          updatesP10: quantile(perTerminal, 0.1),
          submittedPerTerminal: sum(submitted) / count,
          gpuCompletedUpdatesPerTerminal:
            mode === 'shared'
              ? (b.surfaceCompletedUpdates - a.surfaceCompletedUpdates) / s / count
              : null,
          surfaceFrames:
            mode === 'shared'
              ? b.surfaceFrames.map((f, i) => (f - (a.surfaceFrames[i] ?? 0)) / s)
              : null,
          surfaceCompletedFrames:
            mode === 'shared'
              ? b.surfaceCompletedFrames.map((f, i) => (f - (a.surfaceCompletedFrames[i] ?? 0)) / s)
              : null,
          longTasks: b.longTasks.count - a.longTasks.count,
          longTaskMs: b.longTasks.ms - a.longTasks.ms,
          atlases: b.atlases,
          memoryMiB: Math.round(memory),
          browserCpuCores: (cpuB - cpuA) / ((wallB - wallA) / 1000),
          loadAverage1m: [loadBefore[0], loadAfter[0]],
          power,
          idleDisplayHz: Math.round(idleHz),
          terminalErrors: b.errors.length,
        };
        if (errors.length) run.pageErrors = errors.slice(0, 5);
      } catch (error) {
        run.failed = String(error.message ?? error).slice(0, 300);
      }
      await browser.close();
      runs.push(run);
      console.log(
        run.failed
          ? `${round} ${count} ${mode}/${feed}: FAILED ${run.failed}`
          : `${round} ${count} ${mode}/${feed}: ${run.power}, load ${run.loadAverage1m.map((l) => l.toFixed(1)).join('→')}, cpu ${run.browserCpuCores.toFixed(1)} cores, mount ${run.mountMs} ms, display ${run.displayFps.toFixed(1)} fps, ${run.updatesPerTerminal.toFixed(1)} updates/terminal/s (p10 ${run.updatesP10.toFixed(1)}), submitted ${run.submittedPerTerminal.toFixed(1)}, gpu ${run.gpuCompletedUpdatesPerTerminal?.toFixed(1) ?? '-'}, long tasks ${run.longTasks} (${run.longTaskMs.toFixed(0)} ms), ${run.memoryMiB} MiB, idle ${run.idleDisplayHz} Hz`,
      );
    }

const sha = async (f) =>
  createHash('sha256')
    .update(await readFile(resolve(root, f)))
    .digest('hex');
const summary = {};
for (const count of counts)
  for (const { mode, feed } of configs) {
    const label = `${count} ${mode}${mode === 'shared' ? ` ${feed}` : ''}`;
    const all = runs.filter((x) => x.count === count && x.mode === mode && x.feed === feed);
    const r = all.filter((x) => !x.failed);
    if (!r.length) {
      summary[label] = { failed: all.map((x) => x.failed) };
      continue;
    }
    const range = (key) => [Math.min(...r.map((x) => x[key])), Math.max(...r.map((x) => x[key]))];
    summary[label] = {
      runs: r.length,
      displayFps: range('displayFps'),
      updatesPerTerminal: range('updatesPerTerminal'),
      updatesP10: range('updatesP10'),
      submittedPerTerminal: range('submittedPerTerminal'),
      ...(mode === 'shared' && {
        gpuCompletedUpdatesPerTerminal: range('gpuCompletedUpdatesPerTerminal'),
      }),
      longTasks: range('longTasks'),
      longTaskMs: range('longTaskMs'),
      mountMs: range('mountMs'),
      memoryMiB: range('memoryMiB'),
      browserCpuCores: range('browserCpuCores'),
      loadAverage1m: [
        Math.min(...r.flatMap((x) => x.loadAverage1m)),
        Math.max(...r.flatMap((x) => x.loadAverage1m)),
      ],
    };
  }
await mkdir(out, { recursive: true });
await writeFile(
  resolve(out, process.env.RESULTS ?? 'results.json'),
  JSON.stringify(
    {
      measured: new Date().toISOString(),
      // The page under test may come from another build (BUILD names it).
      url: base,
      build: process.env.BUILD,
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      sources: Object.fromEntries(
        await Promise.all(
          [
            'packages/wraith/wasm/wraith_engine_bg.wasm',
            'packages/wraith/src/index.ts',
            'packages/wraith/src/pool.ts',
            'packages/wraith/src/surface.ts',
            'packages/wraith/src/shared-host.ts',
            'packages/wraith/src/worker.ts',
            'packages/wraith/src/batch.ts',
            'packages/wraith/src/placement.ts',
            'demo/fleet.js',
            'scripts/fleet-benchmark.mjs',
          ].map(async (f) => [f, await sha(f)]),
        ),
      ),
      browser: userAgent,
      cpu: cpus()[0]?.model,
      headed: process.env.HEADED === '1',
      method: {
        page: 'demo/fleet.html, 1600x900 CSS px at DPR 2, grid fitted to the window (terminals CSS-scaled below 1:1)',
        terminals: `80x24, JetBrains Mono 7 px, line height 1.2, scrollback 1000, Wraith.pool({ workers: ${workers} })`,
        update:
          'logUpdate from demo/rival-bench.js: two colored agent-log lines and a rewritten status row',
        feeds: {
          main: 'one main-thread requestAnimationFrame driver: each terminal writes its next update once the previous write resolved (parsed), at most once per display frame',
          worker:
            "shared only: each pool worker replays its terminals' updates itself (64 precomputed logUpdate chunks per terminal, internal 'feed' command), one per terminal per worker animation frame; nothing crosses the main thread while streaming. Parsed counts are read from the workers at the window edges.",
        },
        warm,
        seconds,
        displayFps: 'main-thread requestAnimationFrame callbacks per second during the window',
        updatesPerTerminal:
          'updates parsed per terminal per second (main: write() resolved; worker: chunks parsed in the worker)',
        submittedPerTerminal:
          'frames each terminal submitted (Wraith stats frames, reported every 500 ms) per second; not display presentation',
        gpuCompletedUpdatesPerTerminal:
          'shared only: terminal updates drawn into presented surface frames whose GPU work completed (onSubmittedWorkDone)',
        surfaceFrames: 'shared only: frames each worker presented to its canvas per second',
        longTasks:
          'PerformanceObserver longtask entries (>50 ms) on the main thread during the window',
        memory: 'summed RSS of the browser and all its processes, sampled mid-window',
        browserCpuCores:
          'CPU time of the browser and all its processes (ps) over the window, divided by wall time',
        loadAverage1m: 'os.loadavg() 1-minute value before and after the window (whole machine)',
        power: 'pmset -g batt power source after the window',
      },
      summary,
      runs,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(summary, null, 1));
