// Records the warm showcase dashboard running live in a full-window Wraith terminal
// (libghostty-vt in a worker, WebGPU), updating eight times a second like a real monitor.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const dir = resolve(import.meta.dirname, '../.cache/frames/dashboard');
const out = resolve(import.meta.dirname, '../footage/dashboard.mp4');
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/playground.html');
await page.waitForFunction(() => window.Wraith && window.wraith, undefined, { timeout: 30000 });
const grid = await page.evaluate(async () => {
  await window.wraith.dispose();
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#0c0806;overflow:hidden';
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0';
  document.body.append(host);
  const term = await window.Wraith.mount(host, {
    fontSize: 16,
    lineHeight: 1.2,
    theme: { background: '#0c0806', foreground: '#f2e6da', cursor: '#0c0806' },
  });
  const { showcase } = await import('/showcase.js');
  const encoder = new TextEncoder();
  let variant = 0;
  window.dashboard = setInterval(() => {
    void term.write(showcase(term.cols, term.rows, variant++ % 8, encoder).bytes);
  }, 125);
  await new Promise((r) => setTimeout(r, 1500));
  return `${term.cols}x${term.rows}`;
});
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
  quality: 94,
  maxWidth: 1920,
  maxHeight: 1080,
});
await page.waitForTimeout(10000);
await cdp.send('Page.stopScreencast');
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
  out,
]);
console.log(
  `dashboard ${grid}: ${frames.length} frames over ${(frames.at(-1).t - frames[0].t).toFixed(1)} s; errors ${JSON.stringify(errors)}`,
);
await browser.close();
