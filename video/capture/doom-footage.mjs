// Real-time footage of a doomterm stream playing at DOOM's 35 Hz in one terminal.
// CDP screencast keeps each captured frame's timestamp, so the recording shows the
// cadence the page produced; timings come from doom-bench.mjs, not from this.
// Usage: node doom-footage.mjs <output name> <webgl|wraith|native> <stream name> <cols>x<rows>
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [name, type, stream, grid] = process.argv.slice(2);
const [cols, rows] = grid.split('x').map(Number);
const repo = resolve(import.meta.dirname, '../..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5199';
const seconds = Number(process.env.SECONDS ?? 10);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu'],
});
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/compare.html');
await page.evaluate(
  async ([m, t, u, c, r, s]) => (await import(m)).run(t, u, c, r, 'paced', s),
  [
    '/@fs' + resolve(import.meta.dirname, 'doom-player.js'),
    type,
    '/@fs' + resolve(repo, '.cache/doom', `${stream}.ansi`),
    cols,
    rows,
    seconds + 3,
  ],
);
await page.waitForTimeout(1500);
const dir = resolve(repo, '.cache/frames', name);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const cdp = await page.context().newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  frames.push({ data, t: metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 92,
  maxWidth: 1920,
  maxHeight: 1080,
});
await page.waitForTimeout(seconds * 1000);
await cdp.send('Page.stopScreencast');
const shown = await page.evaluate(() => window.doom.shown);
let list = '';
for (let i = 0; i < frames.length; i++) {
  const file = `${String(i).padStart(5, '0')}.jpg`;
  await writeFile(resolve(dir, file), Buffer.from(frames[i].data, 'base64'));
  const next = frames[i + 1]?.t ?? frames[i].t + 1 / 60;
  list += `file '${file}'\nduration ${Math.max(0.001, next - frames[i].t).toFixed(4)}\n`;
}
await writeFile(resolve(dir, 'list.txt'), list);
await mkdir(resolve(repo, 'video/footage'), { recursive: true });
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
const window_ = shown.filter((t) => t > 1500 && t < 1500 + seconds * 1000);
console.log(
  `${name}: ${type} ${stream}; ${(window_.length / seconds).toFixed(1)} game frames shown/s during capture; ${frames.length} captured; errors ${JSON.stringify(errors)}`,
);
await browser.close();
if (errors.length) process.exit(1);
