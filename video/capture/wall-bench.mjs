// Measures "the wall": N tiled terminals each playing truecolor half-block animation
// (alternating raycaster and tunnel), for xterm.js + WebGL, Wraith compatible and Wraith
// native. Each renderer runs in its own page; order rotates across rounds. After a warm-up,
// the clock restarts and frames shown per terminal per second are recorded. Run alone:
// no capture, rendering or other benchmarks alongside.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5199';
const module = '/@fs' + resolve(import.meta.dirname, 'halfblock.js');
const [cols, rows] = (process.env.GRID ?? '160x50').split('x').map(Number);
const count = Number(process.env.COUNT ?? 16);
const dpr = Number(process.env.DPR ?? 2);
const warmMs = 3000,
  measureMs = 8000;
const orders = [
  ['webgl', 'wraith', 'native'],
  ['wraith', 'native', 'webgl'],
  ['native', 'webgl', 'wraith'],
];
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu'],
});
const runs = [];
let adapter, userAgent;
for (const [round, order] of orders.entries())
  for (const type of order) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: dpr,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/compare.html');
    await page.evaluate(
      async ([m, t, c, r, n]) => (await import(m)).run(t, c, r, 90, n, 'mix'),
      [module, type, cols, rows, count],
    );
    await page.waitForTimeout(warmMs);
    await page.evaluate(() => window.reset());
    await page.waitForTimeout(measureMs);
    const result = await page.evaluate(() => ({
      meanFps: window.rate(),
      minTerminalFps: window.minRate(),
      terminals: window.terms,
      renderer: window.renderer,
      frameBytes: window.frameBytes,
    }));
    await page.evaluate(() => window.stop());
    userAgent ??= await page.evaluate(() => navigator.userAgent);
    adapter ??= await page
      .evaluate(async () => {
        const a = await navigator.gpu?.requestAdapter();
        return a ? { ...a.info } : null;
      })
      .catch(() => null);
    if (errors.length) throw Error(`${type}: ${errors.join('; ')}`);
    if (result.terminals !== count) throw Error(`${type}: mounted ${result.terminals}`);
    const renderers = [result.renderer].flat().map(String);
    if (type === 'wraith' && renderers.some((r) => r !== 'webgpu'))
      throw Error(`Wraith compatible fell back: ${renderers}`);
    runs.push({ round, type, ...result, renderer: [...new Set(renderers)].join('/') });
    console.log(round, type, result.meanFps.toFixed(1), result.minTerminalFps.toFixed(1));
    await page.close();
  }
await browser.close();

const fps = (type, key = 'meanFps') => runs.filter((r) => r.type === type).map((r) => r[key]);
const sha = async (f) =>
  createHash('sha256')
    .update(await readFile(resolve(repo, f)))
    .digest('hex');
const record = {
  measured: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  workload: {
    terminals: count,
    grid: `${cols}x${rows}`,
    content: 'alternating raycaster / tunnel, truecolor half-block, every cell recolored per frame',
    viewport: '1920x1080',
    dpr,
    pacing: 'next frame written after the previous write completes and one animation frame',
    nativePacing: 'write() then flush() (waits for render) before the next animation frame',
    warmMs,
    measureMs,
  },
  browser: userAgent,
  adapter,
  sources: Object.fromEntries(
    await Promise.all(
      [
        'video/capture/halfblock.js',
        'video/capture/raycast.js',
        'video/capture/wall-bench.mjs',
      ].map(async (f) => [f, await sha(f)]),
    ),
  ),
  runs,
  bounds: {
    webglFastest: Math.max(...fps('webgl')),
    webglSlowest: Math.min(...fps('webgl')),
    compatibleSlowest: Math.min(...fps('wraith')),
    nativeSlowest: Math.min(...fps('native')),
    nativeSlowestMinTerminal: Math.min(...fps('native', 'minTerminalFps')),
  },
  limits:
    'Short synthetic playback on one machine with unrelated desktop apps running. Frames shown per terminal per second as paced by the page; not physical display FPS.',
};
const out = resolve(repo, process.env.OUT ?? 'video/claims/wall-comparison.json');
await writeFile(out, JSON.stringify(record, null, 2) + '\n');
console.log(record.bounds);
