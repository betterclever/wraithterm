// Mounts `count` 80×24 terminals in a grid and streams agent-style output into each
// at the display's rate: each terminal writes its next update once the previous
// one is parsed and a display frame has passed, as an app would. Reports frames
// each terminal actually rendered per second (Wraith onRender submissions;
// xterm.js onRender), so a renderer that falls behind shows fewer frames.
import { Terminal as Xterm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { Wraith } from '../packages/wraith/dist/index.js';
import '../packages/wraith/css/xterm.css';

const encoder = new TextEncoder();
const LEVELS = [
  ['\x1b[38;2;143;184;255m', '● Read'],
  ['\x1b[38;2;142;224;160m', '  ✓'],
  ['\x1b[38;2;255;204;102m', '  ↻'],
  ['\x1b[38;2;232;224;214m', '   '],
];
function update(id, n) {
  let out = '';
  for (let k = 0; k < 2; k++) {
    const [color, tag] = LEVELS[(n + k) % LEVELS.length];
    out += `\r\n${color}${tag}\x1b[0m agent-${id} step ${n * 2 + k} · src/module-${(n + k) % 37}.ts · ${(n * 7919) % 997} ms`;
  }
  // A status line pinned to the bottom row, rewritten every update.
  return encoder.encode(
    `${out}\x1b7\x1b[24;1H\x1b[48;2;42;29;20m\x1b[38;2;255;176;102m agent-${id} · ${n} updates · ${(n / 60).toFixed(1)} s \x1b[K\x1b[0m\x1b8`,
  );
}

export async function run(type, count, seconds = 8, warm = 2) {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  const across = Math.ceil(Math.sqrt(count * (16 / 9))),
    down = Math.ceil(count / across);
  const grid = document.createElement('div');
  grid.style.cssText = `position:fixed;inset:0;display:grid;grid-template-columns:repeat(${across},1fr);grid-template-rows:repeat(${down},1fr)`;
  document.body.append(grid);
  const font = new FontFace('JetBrains Mono', 'url(/fonts/JetBrainsMono-Regular.ttf)');
  document.fonts.add(await font.load());
  const cellW = innerWidth / across / 80,
    cellH = innerHeight / down / 24;
  const fontSize = Math.max(3, Math.floor(Math.min(cellW / 0.6, cellH) * 100) / 100);
  const pool = type === 'pooled' ? Wraith.pool({ workers: window.POOL_WORKERS ?? 4 }) : undefined;
  let lost = 0;
  const rendered = new Array(count).fill(0);
  const started = performance.now();
  const writers = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const host = document.createElement('div');
      host.style.cssText = 'overflow:hidden;min-width:0;min-height:0';
      grid.append(host);
      if (type === 'pooled' || type === 'dedicated') {
        const term = await Wraith.mount(host, {
          cols: 80,
          rows: 24,
          fit: false,
          fontSize: Math.max(6, fontSize),
          lineHeight: 1,
          pool,
        });
        term.onRender(() => rendered[i]++);
        return async (data) => {
          await term.write(data);
          await new Promise((r) => requestAnimationFrame(r));
        };
      }
      const term = new Xterm({
        cols: 80,
        rows: 24,
        fontSize,
        lineHeight: 1,
        fontFamily: 'JetBrains Mono, monospace',
      });
      term.open(host);
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => lost++);
      term.loadAddon(webgl);
      term.onRender(() => rendered[i]++);
      return (data) =>
        new Promise((done) => term.write(data, () => requestAnimationFrame(() => done())));
    }),
  );
  const mountMs = performance.now() - started;
  const begin = performance.now();
  let t0 = 0;
  const reset = setTimeout(() => {
    t0 = performance.now();
    rendered.fill(0);
  }, warm * 1000);
  await Promise.all(
    writers.map(async (write, i) => {
      for (let n = 0; performance.now() - begin < (warm + seconds) * 1000; n++)
        await write(update(i, n));
    }),
  );
  clearTimeout(reset);
  const elapsed = (performance.now() - t0) / 1000;
  const fps = rendered.map((n) => n / elapsed).sort((a, b) => a - b);
  return {
    mountMs,
    meanFps: fps.reduce((a, b) => a + b, 0) / fps.length,
    p10Fps: fps[Math.floor(fps.length * 0.1)],
    minFps: fps[0],
    lostContexts: lost,
    workers: type === 'pooled' ? pool.size : type === 'dedicated' ? count : 0,
  };
}
