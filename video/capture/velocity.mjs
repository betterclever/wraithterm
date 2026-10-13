// Deterministic real terminal footage, captured from Wraith's public APIs.
// These are terminal cells produced from ANSI, not a recreation in the video renderer.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const evidence = [];
try {
  for (const kind of ['dashboard', 'pipes', 'plasma']) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/playground.html`);
    await page.waitForFunction(() => window.Wraith && window.wraith);
    const info = await page.evaluate(async (kind) => {
      await window.wraith.dispose();
      document.body.innerHTML = '<div id="film"></div>';
      document.body.style.cssText = 'margin:0;background:#0c0806;overflow:hidden';
      const host = document.querySelector('#film');
      host.style.cssText = 'position:fixed;inset:0';
      const term = await window.Wraith.mount(host, {
        fontSize: 16,
        lineHeight: 1.2,
        theme: { background: '#0c0806', foreground: '#f2e6da', cursor: '#0c0806' },
      });
      await new Promise((r) => setTimeout(r, 300));
      const { showcase } = await import('/showcase.js');
      const { createPipesScene, rasterizePipes, encodePipeFrame } = await import('/pipes-scene.js');
      const options = {
        cols: term.cols,
        rows: term.rows,
        pipes: 20,
        length: 18,
        sides: 10,
        seed: 0x199503,
        colors: 'truecolor',
        traffic: 'compact',
      };
      const scene = kind === 'pipes' ? createPipesScene(options) : null;
      const encoder = new TextEncoder();
      window.filmFrame = async (index) => {
        let bytes;
        if (kind === 'dashboard')
          bytes = showcase(term.cols, term.rows, Math.floor(index / 4) % 8, encoder).bytes;
        else if (kind === 'pipes')
          bytes = encodePipeFrame(rasterizePipes(scene, index / 30, options), options).bytes;
        else {
          let text = '\x1b[?25l';
          for (let y = 0; y < term.rows; y++) {
            text += `\x1b[${y + 1};1H`;
            for (let x = 0; x < term.cols; x++) {
              const px = x / term.cols,
                py = y / term.rows,
                t = index / 30;
              const v =
                Math.sin(px * 19 + t * 0.8) +
                Math.cos(py * 17 - t * 0.7) +
                Math.sin((px + py) * 12 + t);
              const k = (v + 3) / 6;
              const r = Math.round(20 + k * 230),
                g = Math.round(12 + k * k * 150),
                b = Math.round(10 + k * k * k * 100);
              text += `\x1b[48;2;${r};${g};${b}m `;
            }
          }
          bytes = encoder.encode(text + '\x1b[0m');
        }
        await term.write(bytes);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      };
      return { cols: term.cols, rows: term.rows, profile: 'libghostty-vt / WebGPU' };
    }, kind);
    const frames = resolve(root, `.cache/velocity-capture/${kind}`);
    await mkdir(frames, { recursive: true });
    for (let i = 0; i < 120; i++) {
      await page.evaluate((i) => window.filmFrame(i), i);
      await page.screenshot({ path: resolve(frames, `${String(i).padStart(4, '0')}.png`) });
    }
    if (errors.length) throw new Error(`${kind}: ${errors.join('; ')}`);
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-framerate',
      '30',
      '-i',
      resolve(frames, '%04d.png'),
      '-c:v',
      'libx264',
      '-crf',
      '14',
      '-preset',
      'medium',
      '-pix_fmt',
      'yuv420p',
      resolve(root, `footage/velocity-${kind}.mp4`),
    ]);
    evidence.push({ kind, ...info, frames: 120, fps: 30, errors });
    console.log(`${kind}: ${info.cols}×${info.rows}, 120 frames, no browser errors`);
    await page.close();
  }
  await writeFile(
    resolve(root, '.cache/velocity-capture/evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
} finally {
  await browser.close();
}
