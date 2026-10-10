// Records "HOW FAST?" as glyph art in a full-window Wraith terminal: letters filled with
// glyphs that change every frame over a fast glyph storm, written as fast as Wraith takes them.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const dir = resolve(import.meta.dirname, '../.cache/frames/howfast');
const out = resolve(import.meta.dirname, '../footage/howfast.mp4');
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
  // Let the terminal fit the window before reading its grid.
  await new Promise((r) => setTimeout(r, 600));
  const { cols, rows } = term;
  // Letter mask: "HOW FAST?" rasterized to the cell grid, cells are about 1:2.
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Cells are about twice as tall as wide; 0.8 keeps the letters tall and bold.
  g.setTransform(1, 0, 0, 0.8, cols / 2, rows / 2);
  let size = 60;
  g.font = `900 ${size}px Helvetica, Arial, sans-serif`;
  size = (size * cols * 0.9) / g.measureText('HOW FAST?').width;
  g.font = `900 ${size}px Helvetica, Arial, sans-serif`;
  g.fillText('HOW FAST?', 0, 0);
  const alpha = g.getImageData(0, 0, cols, rows).data;
  const inside = (x, y) => alpha[(y * cols + x) * 4 + 3] > 110;
  const solid = [...'█▓▒#@%&$WM'];
  const storm = [...'░▒│─┼╳/\\<>=+*·:;01λψΩΣπ∂≈{}[]'];
  const warm = [
    [255, 184, 107],
    [255, 217, 138],
    [255, 127, 110],
    [217, 187, 255],
    [255, 240, 225],
  ];
  let frame = 0;
  const step = () => {
    let s = '\x1b[?25l';
    let last = '';
    for (let y = 0; y < rows; y++) {
      s += `\x1b[${y + 1};1H`;
      for (let x = 0; x < cols; x++) {
        const r = Math.random();
        let ch, fg;
        if (inside(x, y)) {
          ch = solid[(r * solid.length) | 0];
          const w = warm[(x + y + frame) % warm.length];
          fg = w;
        } else if (r < 0.16) {
          ch = storm[(Math.random() * storm.length) | 0];
          const k = 0.25 + Math.random() * 0.35;
          fg = [255 * k, 150 * k, 90 * k];
        } else {
          ch = ' ';
          fg = [0, 0, 0];
        }
        const style = `38;2;${fg[0] | 0};${fg[1] | 0};${fg[2] | 0}`;
        if (style !== last) {
          s += `\x1b[${style}m`;
          last = style;
        }
        s += ch;
      }
    }
    frame++;
    term.write(s).then(() => requestAnimationFrame(step));
  };
  step();
  await new Promise((r) => setTimeout(r, 1500));
  return `${cols}x${rows}`;
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
  quality: 92,
  maxWidth: 1920,
  maxHeight: 1080,
});
await page.waitForTimeout(4000);
await cdp.send('Page.stopScreencast');
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
  '14',
  '-preset',
  'slow',
  out,
]);
const span = frames.at(-1).t - frames[0].t;
console.log(
  `howfast ${grid}: ${frames.length} frames over ${span.toFixed(1)} s (${(frames.length / span).toFixed(1)}/s); errors ${JSON.stringify(errors)}`,
);
await browser.close();
