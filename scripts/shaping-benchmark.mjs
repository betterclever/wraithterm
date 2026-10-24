// Ligature cost: the engine's GPU-fenced benchmark with ligatures off and on.
// The dense workload's rows are printable ASCII with operators throughout, so
// with ligatures on every row is shaped as runs. Alternating order, 3 rounds.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const url = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173/playground.html';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
});
const runs = [];
let userAgent;
for (let round = 0; round < 3; round++)
  for (const ligatures of round % 2 ? [true, false] : [false, true])
    for (const workload of ['dense', 'scroll', 'sparse']) {
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 1,
      });
      await page.goto(url);
      await page.waitForFunction(() => window.wraith);
      const result = await page.evaluate(
        async ([ligatures, workload]) => {
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;inset:0;z-index:10000';
          document.body.append(host);
          const term = await window.wraith.constructor.mount(host, {
            cols: 160,
            rows: 50,
            fit: false,
            ligatures,
          });
          const r = await term.benchmark({ workload, frames: 2048, warmup: 128 });
          await term.dispose();
          return r;
        },
        [ligatures, workload],
      );
      userAgent ??= result.userAgent;
      runs.push({
        round,
        ligatures,
        workload,
        fps: result.fencedFramesPerSecond,
        cpuP50Ms: result.cpuP50Ms,
        cpuP95Ms: result.cpuP95Ms,
      });
      console.log(
        round,
        ligatures ? 'on ' : 'off',
        workload,
        result.fencedFramesPerSecond.toFixed(0),
        'fps',
        result.cpuP95Ms.toFixed(2),
        'ms p95',
      );
      await page.close();
    }
await browser.close();
const summary = {};
for (const workload of ['dense', 'scroll', 'sparse'])
  for (const ligatures of [false, true]) {
    const v = runs
      .filter((r) => r.workload === workload && r.ligatures === ligatures)
      .map((r) => r.fps);
    summary[`${workload} ligatures ${ligatures ? 'on' : 'off'}`] = [Math.min(...v), Math.max(...v)];
  }
const sha = async (f) =>
  createHash('sha256')
    .update(await readFile(resolve(root, f)))
    .digest('hex');
await writeFile(
  resolve(root, process.env.OUT ?? 'docs/benchmarks/shaping/results.json'),
  JSON.stringify(
    {
      measured: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      sources: Object.fromEntries(
        await Promise.all(
          ['packages/wraith/wasm/wraith_engine_bg.wasm', 'scripts/shaping-benchmark.mjs'].map(
            async (f) => [f, await sha(f)],
          ),
        ),
      ),
      browser: userAgent,
      cpu: cpus()[0]?.model,
      method:
        '160x50 native terminal, DPR 1, Wraith benchmark(): 2048 frames after 128 warm-up, GPU fence every 32 frames; GPU-completed frames per second, not display FPS',
      summary,
      runs,
    },
    null,
    2,
  ) + '\n',
);
console.log(summary);
