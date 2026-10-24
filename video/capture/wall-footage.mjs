// Records half-block playback in real time with a CDP screencast, keeping each captured
// frame's own timestamp, so on-screen cadence is what the page actually produced. Capture
// adds load; timings come from wall-bench.mjs, never from these recordings.
// Usage: node wall-footage.mjs <name> <type> <count> <cols>x<rows> <scene>
import { chromium } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const [name, type, count, grid, scene] = process.argv.slice(2);
const [cols, rows] = grid.split('x').map(Number);
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5199';
const module = '/@fs' + resolve(import.meta.dirname, 'halfblock.js');
const seconds = Number(process.env.SECONDS ?? 8);
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
  async ([m, t, c, r, n, s]) => (await import(m)).run(t, c, r, 180, n, s),
  [module, type, cols, rows, Number(count), scene],
);
await page.waitForTimeout(3000);
await page.evaluate(() => window.reset());
const dir = resolve(import.meta.dirname, '../.cache/frames', name);
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
const rate = await page.evaluate(() => window.rate());
let list = '';
for (let i = 0; i < frames.length; i++) {
  const file = `${String(i).padStart(5, '0')}.jpg`;
  await writeFile(resolve(dir, file), Buffer.from(frames[i].data, 'base64'));
  const next = frames[i + 1]?.t ?? frames[i].t + 1 / 60;
  list += `file '${file}'\nduration ${Math.max(0.001, next - frames[i].t).toFixed(4)}\n`;
}
await writeFile(resolve(dir, 'list.txt'), list);
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
  resolve(import.meta.dirname, `../footage/${name}.mp4`),
]);
const span = frames.at(-1).t - frames[0].t;
console.log(
  `${name}: ${type} ${count}x${grid} ${scene}; ${rate.toFixed(1)} frames shown/s per terminal during capture; ${frames.length} captured (${(frames.length / span).toFixed(1)}/s); errors ${JSON.stringify(errors)}`,
);
await browser.close();
if (errors.length) process.exit(1);
