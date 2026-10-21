// Actual current product footage. Capture time is deterministic, not throughput.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..'),
  repo = resolve(root, '..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5199';
const frames = 120,
  fps = 30;
const requested = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const kinds = requested ? [requested] : ['home', 'reactor', 'pipes', 'compatible'];
const evidence = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  base,
  sources: {},
  methodology:
    'Fresh local production SDK served through Vite. Deterministic 30-fps capture for a 60-fps camera edit; not a display-refresh or throughput benchmark. Terminal content is ordinary ANSI rendered by Wraith. The speed reveal is separately measured with the public native GPU-fenced benchmark.',
  captures: [],
};
for (const file of [
  'packages/wraith/src/index.ts',
  'packages/wraith/src/worker.ts',
  'packages/wraith/src/xterm-print.ts',
  'packages/wraith/wasm/wraith_engine_bg.wasm',
  'demo/ghost-sprite.json',
  'demo/ghost-scene.js',
  'demo/pipes-growth.js',
])
  evidence.sources[file] = createHash('sha256')
    .update(await readFile(resolve(repo, file)))
    .digest('hex');
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  for (const kind of kinds) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const out = resolve(root, '.cache/hype/capture', kind);
    await mkdir(out, { recursive: true });
    await page.goto(
      base + (kind === 'home' ? '/' : kind === 'compatible' ? '/xterm.html' : '/playground.html'),
    );
    let info;
    if (kind === 'home') {
      await page.waitForTimeout(1200);
      await page.screenshot({ path: resolve(out, '0000.png') });
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-loop',
        '1',
        '-i',
        resolve(out, '0000.png'),
        '-t',
        '4',
        '-r',
        String(fps),
        '-c:v',
        'libx264',
        '-crf',
        '15',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        resolve(root, 'footage/hype-home.mp4'),
      ]);
      info = { kind, profile: 'current landing page', frames: 120, sourceFrames: 1, fps, errors };
    } else {
      await page.waitForFunction(
        (k) => (k === 'compatible' ? window.compat?.term.renderer === 'webgpu' : !!window.wraith),
        kind,
      );
      info = await page.evaluate(async (kind) => {
        let term;
        if (kind === 'compatible') {
          window.compat.term.dispose();
          document.body.replaceChildren();
          const host = document.createElement('div');
          document.body.append(host);
          document.body.style.cssText = 'margin:0;background:#0c0806;overflow:hidden';
          term = new window.compat.Terminal({
            cols: 192,
            rows: 54,
            fontSize: 16,
            lineHeight: 1.2,
            cursorBlink: false,
            theme: { background: '#0c0806', foreground: '#f5ece3' },
          });
          term.open(host);
          if (!(await term.webgpuReady)) throw Error('Compatible GPU unavailable');
          const write = (s) => new Promise((r) => term.write(s, r));
          await write('\x1b[?25l');
          window.captureFrame = async (index) => {
            const row = Array.from({ length: 64 }, (_, j) => {
              const id = index * 64 + j;
              return `\x1b[38;2;255;${150 + (id % 60)};${80 + (id % 60)}m${String(id).padStart(7, '0')}\x1b[0m  ${'build module pipeline render cache write flush '.repeat(5)}\r\n`;
            }).join('');
            await write(row);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            await term._core._renderService._renderer.value.gpu.fence();
          };
          window.captureText = () =>
            Promise.resolve(
              term.buffer.active.getLine(term.buffer.active.baseY + 20)?.translateToString(),
            );
        } else {
          const C = window.wraith.constructor;
          await window.wraith.dispose();
          document.body.replaceChildren();
          document.body.style.cssText = 'margin:0;background:#0c0806;overflow:hidden';
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;inset:0';
          document.body.append(host);
          term = await C.mount(host, {
            cols: 192,
            rows: 54,
            fit: false,
            fontSize: 16,
            lineHeight: 1.2,
            theme: { background: '#0c0806', foreground: '#f5ece3', cursor: '#0c0806' },
          });
          await term.write('\x1b[?25l');
          if (kind === 'reactor') {
            const { GhostScene } = await import('/ghost-scene.js');
            const scene = new GhostScene(192, 54);
            // Start after the reactor panels have entered; all visible details remain cells.
            window.captureFrame = async (index) => {
              await term.write(scene.frame(3.8 + index / 30).bytes);
              await term.flush();
            };
          } else {
            const { createPipeGrowth } = await import('/pipes-growth.js');
            const { rasterizePipes, encodePipeFrame } = await import('/pipes-scene.js');
            const growth = createPipeGrowth({
              cols: 192,
              rows: 54,
              pipes: 10,
              speed: 2,
              sides: 12,
              seed: 0x199503,
            });
            window.captureFrame = async (index) => {
              const t = 3 + index / 30;
              const f = growth.frame(t);
              await term.write(
                encodePipeFrame(
                  rasterizePipes(f.scene, t, {
                    camera: 'orbit',
                    framing: 'mesh',
                    backdrop: 'ember',
                  }),
                  { traffic: 'compact' },
                ).bytes,
              );
              await term.flush();
            };
          }
          window.captureText = () => term.getText();
        }
        window.captureDispose = () => term.dispose();
        return {
          kind,
          profile:
            kind === 'compatible'
              ? 'xterm-compatible / WebGPU / Unicode 6'
              : 'libghostty worker / WebGPU',
          cols: 192,
          rows: 54,
        };
      }, kind);
      for (let i = 0; i < frames; i++) {
        await page.evaluate((i) => window.captureFrame(i), i);
        await page.screenshot({ path: resolve(out, `${String(i).padStart(4, '0')}.png`) });
      }
      const text = await page.evaluate(() => window.captureText());
      if (!text?.length) throw Error('Empty terminal capture');
      info = {
        ...info,
        frames,
        fps,
        textSha256: createHash('sha256').update(text).digest('hex'),
        errors,
      };
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-framerate',
        String(fps),
        '-i',
        resolve(out, '%04d.png'),
        '-frames:v',
        String(frames),
        '-c:v',
        'libx264',
        '-crf',
        '15',
        '-preset',
        'medium',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        resolve(root, `footage/hype-${kind}.mp4`),
      ]);
      await page.evaluate(() => window.captureDispose());
    }
    if (errors.length) throw Error(errors.join('; '));
    evidence.captures.push(info);
    await writeFile(
      resolve(root, '.cache/hype/capture/evidence.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    console.log(`${kind}: ${info.frames} real product frames captured.`);
    await page.close();
  }
} finally {
  await browser.close();
}
