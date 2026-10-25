// Renderer shoot-out: Wraith native, wterm (built-in and Ghostty cores) and
// xterm.js + WebGL in one page. Mounts `count` terminals and drives a workload at
// the display's rate: each terminal writes its next update once the previous one
// is processed and a display frame has passed, as an app would. Frames are each
// terminal's own render callbacks where the renderer exposes them (Wraith,
// xterm.js); wterm renders on the main thread in its own animation frame, so its
// shown updates are its completed write-and-frame cycles.
import { Terminal as Xterm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { WTerm } from '@wterm/dom';
import { GhosttyCore } from '@wterm/ghostty';
import ghosttyWasm from '@wterm/ghostty/ghostty-vt.wasm?url';
import '@wterm/dom/css';
import { Wraith } from '../packages/wraith/dist/index.js';
import { raycastPixels } from './bench-raycast.js';
import '../packages/wraith/css/xterm.css';

// A raymarch-free "tunnel" flythrough: cheap per pixel, but every pixel changes per frame.
function shade(x, y, w, h, t) {
  const u = (x - w / 2) / h,
    v = (y - h / 2) / h;
  const r = Math.hypot(u, v) + 1e-3,
    a = Math.atan2(v, u);
  const depth = 0.35 / r + t * 1.6,
    twist = (a * 3) / Math.PI + t * 0.4;
  const checker = (Math.floor(depth * 4) + Math.floor(twist * 4)) & 1;
  const glow = Math.min(1, r * 1.8);
  const base = checker ? [255, 150, 70] : [70, 30, 120];
  const pulse = 0.6 + 0.4 * Math.sin(depth * 2 - t * 4);
  return base.map((c) => Math.round(c * glow * pulse));
}

function tunnelPixels(w, h, t) {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out.set(shade(x, y, w, h, t), (y * w + x) * 3);
  return out;
}
export const scenes = { tunnel: tunnelPixels, raycast: raycastPixels };

/** Truecolor half-block frames: '▀' with fg = top pixel, bg = bottom pixel. SGR is
 * emitted only when a colour changes, as a real encoder would. */
export function encodeFrames(cols, rows, count, scene = 'tunnel', phase = 0) {
  const encoder = new TextEncoder();
  const frames = [];
  for (let f = 0; f < count; f++) {
    const px = scenes[scene](cols, rows * 2, (f + phase) / 30);
    let out = '\x1b[?25l\x1b[H',
      fg = '',
      bg = '';
    for (let y = 0; y < rows; y++) {
      if (y) out += '\r\n';
      for (let x = 0; x < cols; x++) {
        const a = (y * 2 * cols + x) * 3,
          b = a + cols * 3;
        const top = `${px[a]};${px[a + 1]};${px[a + 2]}`,
          bottom = `${px[b]};${px[b + 1]};${px[b + 2]}`;
        if (top !== fg && bottom !== bg) out += `\x1b[38;2;${top};48;2;${bottom}m`;
        else if (top !== fg) out += `\x1b[38;2;${top}m`;
        else if (bottom !== bg) out += `\x1b[48;2;${bottom}m`;
        fg = top;
        bg = bottom;
        out += '▀';
      }
    }
    frames.push(encoder.encode(out + '\x1b[0m'));
  }
  return frames;
}

const encoder = new TextEncoder();
function logUpdate(id, n) {
  const levels = [
    '\x1b[38;2;143;184;255m● Read',
    '\x1b[38;2;142;224;160m  ✓',
    '\x1b[38;2;255;204;102m  ↻',
    '\x1b[38;2;232;224;214m   ',
  ];
  let out = '';
  for (let k = 0; k < 2; k++)
    out += `\r\n${levels[(n + k) % 4]}\x1b[0m agent-${id} step ${n * 2 + k} · src/module-${(n + k) % 37}.ts · ${(n * 7919) % 997} ms`;
  return encoder.encode(
    `${out}\x1b7\x1b[24;1H\x1b[48;2;42;29;20m\x1b[38;2;255;176;102m agent-${id} · ${n} updates \x1b[K\x1b[0m\x1b8`,
  );
}
/** Recorded doomterm frames (split at each cursor-home), from a URL. */
async function recorded(url) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const starts = [];
  for (let i = 0; i + 2 < bytes.length; i++)
    if (bytes[i] === 27 && bytes[i + 1] === 91 && bytes[i + 2] === 72) starts.push(i);
  return starts.map((s, n) => bytes.subarray(n ? s : 0, starts[n + 1] ?? bytes.length));
}

async function mount(type, host, cols, rows, fontSize, lineHeight, rendered, i) {
  if (type === 'wraith') {
    const term = await Wraith.mount(host, {
      cols,
      rows,
      fit: false,
      fontSize,
      lineHeight,
      pool: window.benchPool,
    });
    term.onRender(() => rendered[i]++);
    return {
      write: async (data) => {
        await term.write(data);
        await new Promise((r) => requestAnimationFrame(r));
      },
      counted: true,
    };
  }
  if (type === 'webgl') {
    const term = new Xterm({
      cols,
      rows,
      fontSize,
      lineHeight,
      fontFamily: 'JetBrains Mono, monospace',
      allowProposedApi: true,
    });
    term.open(host);
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => (window.benchLost = (window.benchLost ?? 0) + 1));
    term.loadAddon(webgl);
    term.onRender(() => rendered[i]++);
    return {
      write: (data) =>
        new Promise((done) => term.write(data, () => requestAnimationFrame(() => done()))),
      counted: true,
    };
  }
  // wterm: write() is synchronous and schedules its own animation frame first, so
  // the frame callback below runs after that render, in the same frame.
  const core =
    type === 'wterm-ghostty' ? await GhosttyCore.load({ wasmPath: ghosttyWasm }) : undefined;
  // wterm sizes cells from its own variables on the host; match the others' grid.
  host.style.setProperty('--term-font-size', `${fontSize}px`);
  host.style.setProperty('--term-line-height', String(lineHeight));
  host.style.setProperty('--term-row-height', `${Math.ceil(fontSize * lineHeight)}px`);
  host.style.setProperty('--term-font-family', 'JetBrains Mono, monospace');
  host.style.padding = '0';
  const term = new WTerm(host, { cols, rows, autoResize: false, core, onData: () => {} });
  await term.init();
  return {
    write: (data) =>
      new Promise((done) => {
        term.write(data);
        requestAnimationFrame(() => done());
      }),
    counted: false,
  };
}

/**
 * workload: 'halfblock' (truecolor raycaster/tunnel, every cell every frame),
 * 'logs' (agent output), or a URL ending in .ansi (recorded doomterm frames).
 */
export async function run(type, count, cols, rows, workload, seconds = 8, warm = 2) {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  const across = Math.ceil(Math.sqrt(count * (16 / 9))),
    down = Math.ceil(count / across);
  const grid = document.createElement('div');
  grid.style.cssText = `position:fixed;inset:0;display:grid;grid-template-columns:repeat(${across},1fr);grid-template-rows:repeat(${down},1fr)`;
  document.body.append(grid);
  const font = new FontFace('JetBrains Mono', 'url(/fonts/JetBrainsMono-Regular.ttf)');
  document.fonts.add(await font.load());
  const fontSize = Math.max(
    6,
    Math.floor(Math.min(innerWidth / across / cols / 0.6, innerHeight / down / rows) * 100) / 100,
  );
  const lineHeight = 1;
  if (type === 'wraith' && count > 1) window.benchPool = Wraith.pool({ workers: 4 });
  window.benchLost = 0;
  const rendered = new Array(count).fill(0);
  const started = performance.now();
  const terms = await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const host = document.createElement('div');
      host.style.cssText = 'overflow:hidden;min-width:0;min-height:0';
      grid.append(host);
      return mount(type, host, cols, rows, fontSize, lineHeight, rendered, i);
    }),
  );
  const mountMs = performance.now() - started;
  let frames;
  if (workload === 'halfblock') {
    const sets = {
      raycast: encodeFrames(cols, rows, 90, 'raycast'),
      tunnel: encodeFrames(cols, rows, 90, 'tunnel'),
    };
    frames = (i, n) => sets[i % 2 ? 'tunnel' : 'raycast'][(n + i * 7) % 90];
  } else if (workload === 'logs') frames = (i, n) => logUpdate(i, n);
  else {
    const doom = await recorded(workload);
    for (const t of terms) await t.write(doom[0]);
    frames = (i, n) => doom[1 + ((n + i * 13) % (doom.length - 1))];
  }
  const shown = new Array(count).fill(0);
  const begin = performance.now();
  let t0 = 0;
  const reset = setTimeout(() => {
    t0 = performance.now();
    shown.fill(0);
    rendered.fill(0);
  }, warm * 1000);
  await Promise.all(
    terms.map(async (t, i) => {
      for (let n = 0; performance.now() - begin < (warm + seconds) * 1000; n++) {
        await t.write(frames(i, n));
        shown[i]++;
      }
    }),
  );
  clearTimeout(reset);
  const elapsed = (performance.now() - t0) / 1000;
  // A counted renderer shows at most what it rendered and at most what it was given.
  const fps = terms
    .map((t, i) => (t.counted ? Math.min(rendered[i], shown[i]) : shown[i]) / elapsed)
    .sort((a, b) => a - b);
  return {
    mountMs,
    meanFps: fps.reduce((a, b) => a + b, 0) / fps.length,
    p10Fps: fps[Math.floor(fps.length * 0.1)],
    lostContexts: window.benchLost,
    fontSize,
  };
}
