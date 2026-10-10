// Records each terminal running the dashboard flat out, for the before/after opening.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const module = '/@fs' + resolve(import.meta.dirname, 'terminals.js');
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const [cols, rows] = (process.env.GRID ?? '200x56').split('x').map(Number);
for (const type of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['dom', 'webgl', 'wraith']) {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/compare.html?type=wraith&workload=showcase');
  await page.evaluate(
    async ([m, t, c, r]) => (await import(m)).run(t, c, r),
    [module, type, cols, rows],
  );
  await page.waitForTimeout(2000);
  const dir = resolve(import.meta.dirname, '../.cache/frames', type);
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
  await page.waitForTimeout(9000);
  await cdp.send('Page.stopScreencast');
  const info = await page.evaluate(() => ({ rate: window.rate(), grid: window.grid }));
  let list = '';
  for (let i = 0; i < frames.length; i++) {
    const file = `${String(i).padStart(5, '0')}.jpg`;
    await writeFile(resolve(dir, file), Buffer.from(frames[i].data, 'base64'));
    const next = frames[i + 1]?.t ?? frames[i].t + 1 / 30;
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
    'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p',
    '-c:v',
    'libx264',
    '-crf',
    '15',
    '-preset',
    'slow',
    resolve(import.meta.dirname, `../footage/${type}.mp4`),
  ]);
  const span = frames.at(-1).t - frames[0].t;
  console.log(
    `${type} ${info.grid}: ${info.rate.toFixed(1)} dashboard updates/s; ${frames.length} captured frames (${(frames.length / span).toFixed(1)}/s); errors ${JSON.stringify(errors)}`,
  );
  await page.close();
}
await browser.close();
