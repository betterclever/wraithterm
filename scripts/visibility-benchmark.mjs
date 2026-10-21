import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { pixelSummary } from './png.mjs';
const output = process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/native-visibility/paired';
const repeats = Number(process.env.WRAITH_REPETITIONS ?? 5);
const steps = Number(process.env.WRAITH_STEPS ?? 36),
  hz = 12;
const modes = (
  process.env.WRAITH_VISIBILITY_MODES ?? 'visible,display-none,offscreen,clipped'
).split(',');
assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 10);
assert(Number.isInteger(steps) && steps >= 12 && steps <= 240);
assert(modes.every((m) => ['visible', 'display-none', 'offscreen', 'clipped'].includes(m)));
const files = [
  'packages/wraith/src/index.ts',
  'packages/wraith/src/worker.ts',
  'packages/wraith/wasm/wraith_engine_bg.wasm',
];
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sources = async (root) =>
  Object.fromEntries(
    await Promise.all(files.map(async (f) => [f, sha(await readFile(`${root}/${f}`))])),
  );
const builds = [
  {
    name: 'after',
    url: process.env.WRAITH_URL ?? 'http://127.0.0.1:5196',
    root: process.cwd(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  },
];
if (process.env.WRAITH_BEFORE_URL) {
  assert(process.env.WRAITH_BEFORE_SOURCE_ROOT && process.env.WRAITH_BEFORE_HASH);
  builds.unshift({
    name: 'before',
    url: process.env.WRAITH_BEFORE_URL,
    root: process.env.WRAITH_BEFORE_SOURCE_ROOT,
    head: process.env.WRAITH_BEFORE_HASH,
  });
}
for (const build of builds) build.sources = await sources(build.root);
const report = {
  date: new Date().toISOString(),
  builds,
  runnerSha256: sha(await readFile(new URL(import.meta.url))),
  cpu: cpus()[0].model,
  logicalCpus: cpus().length,
  os: `${process.platform} ${release()}`,
  config: { repeats, steps, hz, terminals: 8, cols: 80, rows: 24, history: 1000, modes },
  methodology:
    'Production SDK. Isolated Chrome per record; alternate before/after order per repetition. Eight worker/GPU terminals, 64 fixed-width log lines per batch, fixed-count offered 12 batches/s; acknowledged bytes and achieved rate retained. No flush during load. onRender counts submissions, not GPU completion or display frames. CPU: cumulative isolated Chrome process CPU-time / wall seconds; 100% is one logical core. Process-set changes invalidate that CPU estimate. State hashes and reveal screenshot checks run outside measurement. Unrelated host applications remain running; no GPU-utilization percentage is inferred.',
  results: [],
};
try {
  report.hostCpuSnapshot = execFileSync('ps', ['-Ao', 'pcpu,comm', '-r'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .slice(1, 9)
    .map((s) => {
      const m = s.trim().match(/^([\d.]+)\s+(.+)$/);
      return m
        ? { cpuCorePercent: Number(m[1]), command: m[2].split('/').at(-1) }
        : { unavailable: s };
    });
} catch {
  report.hostCpuSnapshot = null;
}
await mkdir(output, { recursive: true });
const save = () => writeFile(`${output}/runs.json`, JSON.stringify(report, null, 2) + '\n');
for (let repeat = 0; repeat < repeats; repeat++)
  for (const mode of modes)
    for (const build of repeat % 2 ? [...builds].reverse() : builds) {
      const browser = await chromium.launch({
        executablePath:
          process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
      });
      try {
        const errors = [];
        const page = await browser.newPage({
          viewport: { width: 2200, height: 900 },
          deviceScaleFactor: 1,
        });
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(build.url + '/playground.html');
        await page.waitForFunction(() => window.wraith);
        report.userAgent ??= await page.evaluate(() => navigator.userAgent);
        const geometry = await page.evaluate(async (mode) => {
          const C = window.wraith.constructor;
          await window.wraith.dispose();
          document.body.replaceChildren();
          const clip = document.createElement('div');
          clip.id = 'clip';
          clip.style.cssText =
            'position:fixed;left:0;top:0;width:2200px;height:900px;overflow:hidden';
          document.body.append(clip);
          window.terms = [];
          window.counts = [];
          window.hosts = [];
          window.metrics = [];
          for (let i = 0; i < 8; i++) {
            const host = document.createElement('div');
            host.style.cssText = `position:absolute;left:${(i % 4) * 540}px;top:${Math.floor(i / 4) * 400}px;width:530px;height:390px`;
            clip.append(host);
            window.hosts.push(host);
            const term = await C.mount(host, {
              cols: 80,
              rows: 24,
              fontSize: 10,
              scrollback: 1000,
              fit: false,
            });
            window.terms.push(term);
            window.counts[i] = 0;
            term.onRender(() => window.counts[i]++);
            term.onStats((s) => (window.metrics[i] = s));
            term.onError((e) => {
              throw e;
            });
            await term.write('\x1b[?25lready');
            await term.flush();
          }
          const geometry = window.terms.map((t) => {
            const r = t.canvas.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          });
          if (mode === 'display-none') clip.style.display = 'none';
          if (mode === 'offscreen') clip.style.top = '20000px';
          if (mode === 'clipped') {
            clip.style.height = '1px';
            for (const h of window.hosts) h.style.top = '10px';
          }
          await new Promise((r) => setTimeout(r, 300));
          window.load = async (steps, hz) => {
            const counts = [...window.counts],
              start = performance.now();
            let bytes = 0;
            const durations = [];
            for (let step = 0; step < steps; step++) {
              const target = start + (step * 1000) / hz;
              if (target > performance.now())
                await new Promise((r) => setTimeout(r, target - performance.now()));
              const payload = Array.from(
                { length: 64 },
                (_, line) =>
                  `\r\n${String(step).padStart(3, '0')}:${String(line).padStart(2, '0')} ${'log data '.repeat(7)}`,
              ).join('');
              const at = performance.now();
              await Promise.all(window.terms.map((t) => t.write(payload)));
              durations.push(performance.now() - at);
              bytes += new TextEncoder().encode(payload).length * window.terms.length;
            }
            const end = start + (steps * 1000) / hz;
            if (end > performance.now())
              await new Promise((r) => setTimeout(r, end - performance.now()));
            return {
              elapsedMs: performance.now() - start,
              batches: steps,
              acknowledgedBytes: bytes,
              frames: window.counts.map((n, i) => n - counts[i]),
              acknowledgementMs: durations,
            };
          };
          return geometry;
        }, mode);
        assert(
          geometry.every(
            (r) => r.x >= 0 && r.y >= 0 && r.x + r.width <= 2200 && r.y + r.height <= 900,
          ),
          'Visible control canvas fits viewport',
        );
        const cdp = await browser.newBrowserCDPSession();
        const start = performance.now(),
          cpuBefore = await cdp.send('SystemInfo.getProcessInfo');
        const loaded = await page.evaluate(async ({ steps, hz }) => window.load(steps, hz), {
          steps,
          hz,
        });
        const cpuAfter = await cdp.send('SystemInfo.getProcessInfo'),
          elapsedMs = performance.now() - start;
        const beforeMap = new Map(cpuBefore.processInfo.map((p) => [p.id, p]));
        const stable =
          beforeMap.size === cpuAfter.processInfo.length &&
          cpuAfter.processInfo.every((p) => beforeMap.has(p.id));
        let cpu = { stable, elapsedMs, before: cpuBefore.processInfo, after: cpuAfter.processInfo };
        if (stable) {
          const byType = {};
          for (const p of cpuAfter.processInfo)
            byType[p.type] =
              (byType[p.type] ?? 0) +
              ((p.cpuTime - beforeMap.get(p.id).cpuTime) * 100000) / elapsedMs;
          const totalPercent = Object.values(byType).reduce((a, b) => a + b, 0);
          cpu = {
            ...cpu,
            byType,
            totalPercent,
            machineCapacityPercent: totalPercent / cpus().length,
          };
        }
        const state = await page.evaluate(async () => {
          const visible = await Promise.all(window.terms.map((t) => t.getText()));
          for (const t of window.terms) t.scroll(-10000);
          const history = await Promise.all(window.terms.map((t) => t.getText()));
          for (const t of window.terms) t.scroll(10000);
          await Promise.all(window.terms.map((t) => t.flush()));
          // Forced flush cleaned dirty state; reveal must repaint even without more writes.
          await new Promise((r) => setTimeout(r, 100));
          const frames = [...window.counts];
          const clip = document.getElementById('clip');
          Object.assign(clip.style, { display: 'block', top: '0', height: '900px' });
          window.hosts.forEach((h, i) => (h.style.top = `${Math.floor(i / 4) * 400}px`));
          await new Promise((r) => setTimeout(r, 300));
          return {
            visible,
            history,
            revealFrames: window.counts.map((n, i) => n - frames[i]),
            stats: window.metrics,
          };
        });
        assert(
          state.visible.every((s) => s.includes(`${String(steps - 1).padStart(3, '0')}:63`)),
          'Fresh final state',
        );
        assert(
          state.history.every((s) => s.length > 0),
          'Scrollback retained',
        );
        if (build.name === 'after' && mode !== 'visible')
          assert(
            loaded.frames.every((n) => n === 0),
            'Hidden submissions must stop',
          );
        if (mode === 'visible')
          assert(
            loaded.frames.every((n) => n > 0),
            'Visible control must render',
          );
        if (build.name === 'after' && mode !== 'visible')
          assert(
            state.revealFrames.every((n) => n > 0),
            'Clean reveal must repaint',
          );
        const png = await page.locator('canvas').first().screenshot();
        const pixels = pixelSummary(png);
        assert(pixels.bright > 100 && pixels.colors > 10);
        if (repeat === 0) await writeFile(`${output}/${build.name}-${mode}.png`, png);
        assert.deepEqual(errors, []);
        const record = {
          build: build.name,
          repeat,
          mode,
          geometry,
          ...loaded,
          batchesPerSecond: (loaded.batches * 1000) / loaded.elapsedMs,
          cpu,
          textHash: sha(JSON.stringify(state.visible)),
          historyHash: sha(JSON.stringify(state.history)),
          revealFrames: state.revealFrames,
          pixels,
          errors,
        };
        report.results.push(record);
        console.log(
          JSON.stringify({
            build: build.name,
            repeat,
            mode,
            frames: loaded.frames.reduce((a, b) => a + b, 0),
            batchesPerSecond: record.batchesPerSecond,
            cpu: cpu.totalPercent,
          }),
        );
        await page.evaluate(async () => {
          await Promise.all(window.terms.map((t) => t.dispose()));
        });
      } finally {
        await browser.close();
        await save();
      }
    }
for (const r of report.results) {
  const ref = report.results[0];
  assert.equal(r.textHash, ref.textHash);
  assert.equal(r.historyHash, ref.historyHash);
}
for (const build of builds)
  assert.deepEqual(await sources(build.root), build.sources, 'Measured source changed');
await save();
