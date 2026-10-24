// Plays a full-screen truecolor half-block animation (two pixels per cell, every cell
// recolored every frame) through xterm.js or Wraith at display rate. Each frame is written
// when the previous write has been processed and a frame has passed, so `rate()` is the
// number of animation frames the terminal actually shows per second. Frames are encoded
// before playback starts. Loaded through the demo's Vite server.
import { Terminal as Xterm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as WraithTerminal } from '../../packages/wraith/src/xterm.ts';
import { Wraith } from '../../packages/wraith/dist/index.js';
import { raycastPixels } from './raycast.js';
import '../../packages/wraith/css/xterm.css';

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

// Tiles `count` terminals in a near-square grid; each plays the same animation with its own
// phase, all at once. `rate()` is the mean frames shown per second per terminal.
export async function run(
  type,
  cols = 240,
  rows = 80,
  frameCount = 120,
  count = 1,
  scene = 'tunnel',
) {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  const across = Math.ceil(Math.sqrt(count)),
    down = Math.ceil(count / across);
  const width = innerWidth / across,
    height = innerHeight / down;
  const font = new FontFace('JetBrains Mono', 'url(/fonts/JetBrainsMono-Regular.ttf)');
  document.fonts.add(await font.load());
  const fontSize = Math.floor((width / cols / 0.6) * 100) / 100;
  const options = {
    fontSize,
    lineHeight: (height / rows / Math.floor((width / cols / 0.6) * 100)) * 100,
    fontFamily: 'JetBrains Mono, monospace',
    theme: { background: '#000000', foreground: '#ffffff', cursor: '#000000' },
    allowProposedApi: true,
  };
  const terms = [];
  for (let i = 0; i < count; i++) {
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:${(i % across) * width}px;top:${Math.floor(i / across) * height}px;width:${width}px;height:${height}px;overflow:hidden`;
    document.body.append(host);
    // The native profile runs Ghostty in its own worker; flush() waits for its render.
    if (type === 'native') {
      const native = await Wraith.mount(host, {
        cols,
        rows,
        fit: false,
        fontSize,
        lineHeight: options.lineHeight,
      });
      terms.push({
        write: (data, done) =>
          native
            .write(data)
            .then(() => native.flush())
            .then(done),
        renderer: 'native',
      });
      continue;
    }
    const term = type === 'wraith' ? new WraithTerminal(options) : new Xterm(options);
    term.open(host);
    if (type === 'webgl') term.loadAddon(new WebglAddon());
    if (type === 'wraith') await term.webgpuReady;
    term.resize(cols, rows);
    terms.push(term);
  }
  // 'mix' alternates raycaster and tunnel tiles; both are encoded once and shared.
  const sets = Object.fromEntries(
    (scene === 'mix' ? ['raycast', 'tunnel'] : [scene]).map((name) => [
      name,
      encodeFrames(cols, rows, frameCount, name),
    ]),
  );
  const tileFrames = terms.map((_, i) =>
    scene === 'mix' ? sets[i % 2 ? 'tunnel' : 'raycast'] : sets[scene],
  );
  const frames = tileFrames[0];
  await Promise.all(
    terms.map((t, i) => new Promise((resolve) => t.write(tileFrames[i][0], resolve))),
  );
  const shown = terms.map(() => 0);
  let playing = true,
    started = performance.now();
  terms.forEach((term, i) => {
    const step = () =>
      term.write(tileFrames[i][(shown[i] + i * 7) % frames.length], () => {
        shown[i]++;
        if (playing) requestAnimationFrame(step);
      });
    step();
  });
  // Restart the clock after warm-up so rates are steady-state.
  window.reset = () => {
    shown.fill(0);
    started = performance.now();
  };
  window.rate = () =>
    (shown.reduce((a, b) => a + b, 0) / count / (performance.now() - started)) * 1000;
  window.minRate = () => (Math.min(...shown) / (performance.now() - started)) * 1000;
  window.stop = () => (playing = false);
  window.grid = `${count}x ${cols}x${rows} ${scene}`;
  window.renderer = type === 'wraith' ? terms.map((t) => t.renderer) : type;
  window.terms = terms.length;
  window.frameBytes = Object.fromEntries(
    Object.entries(sets).map(([k, v]) => [
      k,
      Math.round(v.reduce((a, f) => a + f.length, 0) / v.length),
    ]),
  );
}
