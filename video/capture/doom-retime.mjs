// Footage for a terminal that cannot be screen-recorded without slowing it: play
// a doomterm stream uncaptured at 35 Hz and log which game frames were shown and
// when, then have the same terminal draw each logged frame in a fresh page and
// screenshot it. The clip is that terminal's own rendering, on its own measured
// timeline.
// Usage: node doom-retime.mjs <output name> <webgl|wraith|native> <stream name> <cols>x<rows>
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [name, type, stream, grid] = process.argv.slice(2);
const [cols, rows] = grid.split('x').map(Number);
const repo = resolve(import.meta.dirname, '../..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5199';
const seconds = Number(process.env.SECONDS ?? 10);
const player = '/@fs' + resolve(import.meta.dirname, 'doom-player.js');
const url = '/@fs' + resolve(repo, '.cache/doom', `${stream}.ansi`);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu'],
});
const open = async (mode, length) => {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  });
  await page.goto(base + '/compare.html');
  await page.evaluate(
    async ([m, t, u, c, r, md, s]) => (await import(m)).run(t, u, c, r, md, s),
    [player, type, url, cols, rows, mode, length],
  );
  return page;
};
const live = await open('paced', seconds + 1);
await live.waitForFunction(() => window.doom?.done, null, { timeout: (seconds + 30) * 1000 });
const { shown, indices } = await live.evaluate(() => window.doom);
await live.close();
const start = shown.findIndex((t) => t >= 1000);
const times = shown.slice(start).map((t) => t - shown[start]);
const frames = indices.slice(start);
const dir = resolve(repo, '.cache/frames', name);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const still = await open('paced', 0.01);
await still.waitForFunction(() => window.doom?.done);
let list = '';
for (let i = 0; i < frames.length; i++) {
  await still.evaluate((n) => window.showFrame(n), frames[i]);
  const file = `${String(i).padStart(5, '0')}.png`;
  await still.screenshot({ path: resolve(dir, file) });
  const next = times[i + 1] ?? times[i] + 1000 / 35;
  list += `file '${file}'\nduration ${((next - times[i]) / 1000).toFixed(4)}\n`;
}
await writeFile(resolve(dir, 'list.txt'), list);
await writeFile(resolve(dir, 'timeline.json'), JSON.stringify({ times, frames }));
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'concat',
  '-safe',
  '0',
  '-i',
  resolve(dir, 'list.txt'),
  '-vf',
  'fps=60,scale=1920:1080:flags=lanczos,format=yuv420p',
  '-c:v',
  'libx264',
  '-crf',
  '15',
  '-preset',
  'slow',
  resolve(repo, 'video/footage', `${name}.mp4`),
]);
const span = (times.at(-1) - times[0]) / 1000;
console.log(
  `${name}: ${type} ${stream}; ${(frames.length / span).toFixed(1)} game frames shown/s uncaptured; ${frames.length} stills`,
);
await browser.close();
