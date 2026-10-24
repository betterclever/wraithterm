// Mixed-scene benchmark in a headed window (real display rate). Rotates renderer
// order; records the display's idle animation-frame rate after every run.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5199';
const rounds = Number(process.env.ROUNDS ?? 5),
  seconds = Number(process.env.SECONDS ?? 8);
const plan = (process.env.PLAN ?? 'webgl:display,wraith:display,native:display,native:max')
  .split(',')
  .map((p) => p.split(':'));
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-position=0,0', '--enable-unsafe-webgpu'],
});
const runs = [];
let userAgent;
for (let round = 0; round < rounds; round++)
  for (let k = 0; k < plan.length; k++) {
    const [type, mode] = plan[(k + round) % plan.length];
    const page = await browser.newPage({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/compare.html');
    await page.evaluate((p) => (window.SITE_PNG = p), resolve(root, '.cache/scene/site.png'));
    const result = await page.evaluate(
      async ([m, t, md, s, u]) => (await import(m)).run(t, u, md, s),
      [
        '/@fs' + resolve(root, 'video/capture/work-scene/scene-player.js'),
        type,
        mode,
        seconds,
        '/@fs' + resolve(root, process.env.SCENE ?? 'video/capture/work-scene/work-scene.js'),
      ],
    );
    const hz = await page.evaluate(
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
    if (round === 0 && k === 0 && process.env.SHOT)
      await page.screenshot({ path: process.env.SHOT });
    userAgent ??= await page.evaluate(() => navigator.userAgent);
    if (errors.length) throw new Error(`${type}: ${errors.join('; ')}`);
    runs.push({
      round,
      type,
      mode,
      fps: result.fps,
      frames: result.frames,
      displayHz: Math.round(hz),
    });
    console.log(round, type, mode, result.fps.toFixed(1), Math.round(hz) + ' Hz');
    await page.close();
  }
await browser.close();
const summary = {};
for (const [type, mode] of plan) {
  const v = runs.filter((r) => r.type === type && r.mode === mode).map((r) => r.fps);
  summary[`${type} ${mode}`] = { slowest: Math.min(...v), fastest: Math.max(...v) };
}
const sha = async (f) =>
  createHash('sha256')
    .update(await readFile(resolve(root, f)))
    .digest('hex');
await writeFile(
  resolve(root, process.env.OUT ?? 'video/claims/work-scene.json'),
  JSON.stringify(
    {
      measured: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      sources: Object.fromEntries(
        await Promise.all(
          [
            'packages/wraith/wasm/wraith_engine_bg.wasm',
            'video/capture/work-scene/scene-player.js',
            'video/capture/work-scene/work-scene.js',
          ].map(async (f) => [f, await sha(f)]),
        ),
      ),
      browser: userAgent,
      cpu: cpus()[0]?.model,
      workload:
        '200x60 terminal at 1600x900 DPR 2; each frame: DOOM 640x400 Kitty RGB (i=1, 100x36 cells), PNG chart 396x90 (i=2, 99x12 cells), 24-row truecolor process table, 3 scrolling log lines in a 48..60 region, synchronized output; six static PNG thumbnails sent once; ~1 MiB per frame',
      modes: {
        display:
          'next frame after the previous is shown and a display frame passes (native: flush to GPU fence, then a display frame)',
        max: 'native only: next frame right after flush',
      },
      note: 'xterm.js and the compatible profile do not support Kitty graphics and skip those sequences, so they draw less. Frames shown per second, not physical display FPS beyond the panel rate.',
      summary,
      runs,
    },
    null,
    2,
  ) + '\n',
);
console.log(summary);
