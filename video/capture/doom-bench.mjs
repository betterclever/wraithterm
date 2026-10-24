// DOOM timedemo through terminals: replay a recorded doomterm stream as fast as
// each terminal shows it. Rotates renderer order across rounds; one page per run.
// Usage: node doom-bench.mjs [stream name ...]; streams live in .cache/doom.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5199';
const module = '/@fs' + resolve(import.meta.dirname, 'doom-player.js');
const streams = {
  'text-160x50': { cols: 160, rows: 50, types: ['webgl', 'wraith', 'native'] },
  'text-320x100': { cols: 320, rows: 100, types: ['webgl', 'wraith', 'native'] },
  'kitty-640x400': { cols: 160, rows: 45, types: ['native'] },
};
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(streams);
const mode = process.env.MODE ?? 'paced';
const rounds = Number(process.env.ROUNDS ?? 3),
  seconds = Number(process.env.SECONDS ?? 8);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu'],
});
const runs = [];
let userAgent;
for (let round = 0; round < rounds; round++)
  for (const name of chosen) {
    const { cols, rows, types } = streams[name];
    const order = types.map((_, i) => types[(i + round) % types.length]);
    for (const type of order) {
      const page = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/compare.html');
      const url = '/@fs' + resolve(repo, '.cache/doom', `${name}.ansi`);
      await page.evaluate(
        async ([m, t, u, c, r, s, md]) => (await import(m)).run(t, u, c, r, md, s),
        [module, type, url, cols, rows, seconds, mode],
      );
      await page.waitForFunction(() => window.doom?.done, null, { timeout: (seconds + 60) * 1000 });
      const shown = await page.evaluate(() => window.doom.shown);
      userAgent ??= await page.evaluate(() => navigator.userAgent);
      if (errors.length) throw new Error(`${name} ${type}: ${errors.join('; ')}`);
      // Discard the first second as warm-up.
      const steady = shown.filter((t) => t >= 1000);
      const fps = steady.length / ((steady.at(-1) - steady[0]) / 1000);
      runs.push({ round, stream: name, type, mode, frames: shown.length, fps });
      console.log(`${round} ${name} ${type}: ${fps.toFixed(1)} frames/s (${shown.length} shown)`);
      await page.close();
    }
  }
await browser.close();
const sha = async (f) =>
  createHash('sha256')
    .update(await readFile(resolve(repo, f)))
    .digest('hex');
const summary = {};
for (const name of chosen)
  for (const type of streams[name].types) {
    const fps = runs.filter((r) => r.stream === name && r.type === type).map((r) => r.fps);
    summary[`${name} ${type}`] = { slowest: Math.min(...fps), fastest: Math.max(...fps) };
  }
await writeFile(
  resolve(repo, process.env.OUT ?? `video/claims/doom-${mode}.json`),
  JSON.stringify(
    {
      measured: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
      sources: Object.fromEntries(
        await Promise.all(
          [
            'packages/wraith/wasm/wraith_engine_bg.wasm',
            'video/capture/doom-player.js',
            'video/capture/doom-bench.mjs',
            ...chosen.map((n) => `.cache/doom/${n}.ansi`),
          ].map(async (f) => [f, await sha(f)]),
        ),
      ),
      browser: userAgent,
      cpu: cpus()[0]?.model,
      method: {
        content:
          'Freedoom 0.13.0 (freedoom1.wad) demo1, rendered by doomgeneric with the doomterm backend; byte-identical recorded stream per mode',
        viewport: '1920x1080 at DPR 2',
        mode,
        pacing:
          mode === 'paced'
            ? 'game time at 35 Hz; each terminal shows the newest due frame once its previous one is shown, dropping frames it cannot keep up with'
            : 'timedemo: each frame written once the previous is shown',
        shown:
          'xterm.js and compatible: write callback then a display frame; native: flush(), which waits for the GPU fence',
        seconds,
        warmup: 'first second discarded',
        note: 'frames shown per second while replaying recorded output; not physical display FPS',
      },
      summary,
      runs,
    },
    null,
    2,
  ) + '\n',
);
console.log(summary);
