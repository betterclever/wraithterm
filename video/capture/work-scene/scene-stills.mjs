// Smooth footage of a deterministic scene: native Wraith draws every frame in order;
// every other frame (scene time advances 1/120 s per frame) is screenshotted after
// its GPU fence, giving 60 fps of Wraith's own output. Speed claims come from
// scene-bench, not from this clip.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const name = process.env.NAME ?? 'work-scene-native',
  frames = Number(process.env.FRAMES ?? 960);
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu'],
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1.2,
});
await page.goto('http://127.0.0.1:5199/compare.html');
await page.evaluate(
  async ([site, scene, n, dist]) => {
    window.SITE_PNG = site;
    const { Wraith } = await import(dist);
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0';
    document.body.append(host);
    const font = new FontFace('JetBrains Mono', 'url(/fonts/JetBrainsMono-Regular.ttf)');
    document.fonts.add(await font.load());
    const fontSize = Math.floor(Math.min(innerWidth / 200 / 0.6, innerHeight / 60) * 100) / 100;
    const lineHeight = Math.min(2, Math.max(1, innerHeight / 60 / fontSize));
    window.term = await Wraith.mount(host, {
      cols: 200,
      rows: 60,
      fit: false,
      fontSize,
      lineHeight,
    });
    window.frames = await (await import(scene)).build(n);
  },
  [
    resolve(root, '.cache/scene/site.png'),
    '/@fs' + resolve(root, process.env.SCENE ?? 'video/capture/work-scene/work-scene.js'),
    frames,
    '/@fs' + resolve(root, 'packages/wraith/dist/index.js'),
  ],
);
const dir = resolve(root, '.cache/frames', name);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
for (let f = 0; f < frames; f++) {
  await page.evaluate(async (i) => {
    await window.term.write(window.frames[i]);
    await window.term.flush();
  }, f);
  if (f % 2 === 0)
    await page.screenshot({ path: resolve(dir, `${String(f / 2).padStart(5, '0')}.png`) });
}
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  '-framerate',
  '60',
  '-i',
  resolve(dir, '%05d.png'),
  '-vf',
  'scale=1920:1080:flags=lanczos,format=yuv420p',
  '-c:v',
  'libx264',
  '-crf',
  '16',
  '-preset',
  'slow',
  resolve(root, `video/footage/${name}.mp4`),
]);
console.log(`${name}: ${frames / 2} frames at 60 fps (${frames / 120} s)`);
await browser.close();
