// The benchmark's exact native dense ANSI fixture, replayed for filming.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..'),
  out = resolve(root, '.cache/hype/capture/dense');
await mkdir(out, { recursive: true });
await mkdir(resolve(root, 'footage'), { recursive: true });
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto((process.env.WRAITH_URL ?? 'http://127.0.0.1:5199') + '/playground.html');
  await p.waitForFunction(() => window.wraith);
  await p.evaluate(async () => {
    const C = window.wraith.constructor;
    await window.wraith.dispose();
    document.body.replaceChildren();
    document.body.style.cssText = 'margin:0;background:#0c0806';
    const host = document.createElement('div');
    host.style.cssText = 'width:1920px;height:1200px';
    document.body.append(host);
    window.t = await C.mount(host, {
      cols: 160,
      rows: 50,
      fontSize: 14,
      lineHeight: 1.35,
      fit: false,
    });
    await window.t.write('\x1b[?25l');
    window.dense = async (i) => {
      let s = '\x1b[H';
      for (let y = 0; y < 50; y++) {
        s += `\x1b[${y + 1};1H\x1b[38;5;${((i + y) % 216) + 16}m`;
        for (let x = 0; x < 160; x++) s += String.fromCharCode(33 + ((x + y + i) % 94));
      }
      await window.t.write(s + '\x1b[0m');
      await window.t.flush();
    };
  });
  for (let i = 0; i < 120; i++) {
    await p.evaluate((i) => window.dense(i), i);
    await p
      .locator('canvas')
      .screenshot({ path: resolve(out, `${String(i).padStart(4, '0')}.png`) });
  }
  if (errors.length) throw Error(errors.join('; '));
  await p.evaluate(() => window.t.dispose());
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-framerate',
    '30',
    '-i',
    resolve(out, '%04d.png'),
    '-vf',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v',
    'libx264',
    '-crf',
    '15',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    resolve(root, 'footage/hype-dense.mp4'),
  ]);
  await writeFile(
    resolve(out, 'evidence.json'),
    JSON.stringify(
      {
        frames: 120,
        fps: 30,
        cols: 160,
        rows: 50,
        profile: 'native / libghostty / WebGPU',
        fixture: 'same row-color / glyph cycle as worker dense benchmark',
        errors,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
}
