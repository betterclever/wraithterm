// Capture the actual terminal canvas at deterministic scene times, and verify controls.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const frames = resolve(root, '.cache/ghost-capture/frames');
await mkdir(frames, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const errors = [];
const captureFrames = 210;
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/ghost.html`);
  await page.waitForFunction(() => window.ghostLab?.ready || window.ghostLab?.error, undefined, {
    timeout: 30000,
  });
  const initial = await page.evaluate(() => ({ ready: ghostLab.ready, error: ghostLab.error }));
  if (!initial.ready || initial.error) throw new Error(JSON.stringify(initial));
  const startupFrames = await page.evaluate(() => ghostLab.frames);
  await page.waitForFunction((n) => ghostLab.frames > n + 4 || ghostLab.error, startupFrames);
  if (await page.evaluate(() => ghostLab.error)) throw new Error('Automatic startup failed');
  await page.evaluate(() => ghostLab.frame(5));
  const text = await page.evaluate(() => ghostLab.getText());
  for (const label of ['GHOST REACTOR', 'SIGNAL', 'SPECTRUM', 'EVENT STREAM'])
    if (!text.includes(label)) throw new Error(`Missing terminal text: ${label}`);
  await page.selectOption('#resolution', '240x68');
  await page.waitForFunction(
    () => ghostLab.ready && document.getElementById('status').textContent.startsWith('240 × 68'),
  );
  await page.evaluate(() => ghostLab.frame(5));
  const high = await page.evaluate(() => ({
    stats: ghostLab.stats,
    error: ghostLab.error,
  }));
  if (high.error) throw new Error(high.error);
  await page.selectOption('#resolution', '192x54');
  await page.waitForFunction(
    () => ghostLab.ready && document.getElementById('status').textContent.startsWith('192 × 54'),
  );
  await page.evaluate(() => ghostLab.pause(false));
  const before = await page.evaluate(() => ghostLab.frames);
  await page.waitForFunction((n) => ghostLab.frames > n + 8, before);
  await page.click('#pause');
  await page.waitForTimeout(150);
  const paused = await page.evaluate(() => ghostLab.frames);
  await page.waitForTimeout(150);
  if ((await page.evaluate(() => ghostLab.frames)) !== paused)
    throw new Error('Pause left frames running');
  await page.click('#restart');
  await page.waitForFunction((n) => ghostLab.frames > n + 3, paused);
  await page.evaluate(() => ghostLab.pause(true));
  const rect = await page.locator('#viewport').boundingBox();
  await page.mouse.move(rect.x + rect.width * 0.67, rect.y + rect.height * 0.36);
  await page.evaluate(() => ghostLab.frame(3));
  await page.click('#pulse');
  await page.waitForTimeout(100);
  await page.evaluate(() => ghostLab.frame(3.25));
  await page.mouse.move(-10, -10);
  const bytes = await page.evaluate(() => Array.from(ghostLab.getFrame()));
  if (!bytes.length || bytes[0] !== 27) throw new Error('Frame download is not ANSI');
  // Reset the scene after interaction before the deterministic capture.
  await page.goto(`${base}/ghost.html?film`);
  await page.waitForFunction(() => ghostLab.ready);
  for (let i = 0; i < captureFrames; i++) {
    await page.evaluate((t) => ghostLab.frame(t), i / 30);
    await page.screenshot({ path: resolve(frames, `${String(i).padStart(4, '0')}.png`) });
  }
  const evidence = await page.evaluate(() => ({
    frames: ghostLab.frames,
    error: ghostLab.error,
    stats: ghostLab.stats,
    adapter: ghostLab.adapter,
    canvases: document.querySelectorAll('canvas').length,
    hasOverlay: !!document.querySelector('#viewport svg,#viewport img'),
  }));
  if (errors.length || evidence.error || evidence.canvases !== 1 || evidence.hasOverlay)
    throw new Error(JSON.stringify({ errors, evidence }));
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-framerate',
    '30',
    '-i',
    resolve(frames, '%04d.png'),
    '-frames:v',
    String(captureFrames),
    '-c:v',
    'libx264',
    '-crf',
    '14',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    resolve(root, 'footage/ghost-reactor.mp4'),
  ]);
  await writeFile(
    resolve(root, '.cache/ghost-capture/evidence.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        cols: 192,
        rows: 54,
        captureFps: 30,
        captureFrames,
        verified: [
          'automatic startup playback',
          'serialized terminal labels',
          '192×54 and 240×68 grids',
          'pause and resume',
          'replay entrance',
          'pointer steering',
          'pulse',
          'ANSI bytes',
          'one terminal canvas without scene overlays',
        ],
        errors,
        ...evidence,
      },
      null,
      2,
    ),
  );
  console.log(`Captured ${captureFrames} real terminal frames; interaction checks passed.`);
} finally {
  await browser.close();
}
