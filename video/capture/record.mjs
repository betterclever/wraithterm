// Records site footage for the launch video with Chrome's screencast (JPEG frames with
// timestamps), then resamples them to constant 30 fps H.264 with ffmpeg.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const out = resolve(import.meta.dirname, '../footage');
const work = resolve(import.meta.dirname, '../.cache/frames');
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
async function record(name, script) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(base + '/');
  await page.waitForFunction(
    () => document.querySelector('#hud-fps')?.textContent !== '—',
    undefined,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1500);
  const dir = resolve(work, name);
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
  await script(page);
  await cdp.send('Page.stopScreencast');
  await page.close();
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
    '14',
    '-preset',
    'slow',
    resolve(out, `${name}.mp4`),
  ]);
  const span = frames.at(-1).t - frames[0].t;
  console.log(
    `${name}: ${frames.length} frames over ${span.toFixed(1)} s (${(frames.length / span).toFixed(1)} fps captured)`,
  );
}
if (!process.argv.includes('--race-only'))
  // The hero with a cursor sweeping a figure eight through the plasma.
  await record('hero', async (page) => {
    const start = Date.now();
    while (Date.now() - start < 12000) {
      const t = (Date.now() - start) / 1000;
      await page.mouse.move(1150 + Math.sin(t * 0.9) * 520, 470 + Math.sin(t * 1.8) * 260);
      await page.waitForTimeout(16);
    }
  });
// The race, scrolled into view, from the click until the verdict.
await record('race', async (page) => {
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    const grid = document.querySelector('.race-grid');
    window.scrollTo(0, grid.getBoundingClientRect().top + scrollY - 90);
  });
  await page.waitForTimeout(800);
  await page.click('#race-go');
  await page.waitForFunction(() => !document.querySelector('#race-go').disabled, undefined, {
    timeout: 120000,
  });
  await page.waitForTimeout(2500);
});
await browser.close();
