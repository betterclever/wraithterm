// Mounts xterm.js (DOM or WebGL) or Wraith's xterm-compatible Terminal full-window and feeds
// it the showcase dashboard as fast as it accepts writes: each write starts when the previous
// one has been processed and a frame has passed. Loaded through the demo's Vite server.
import { Terminal as Xterm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as WraithTerminal } from '../../packages/wraith/src/xterm.ts';
import { showcase } from '../../demo/showcase.js';
import '../../packages/wraith/css/xterm.css';

export async function run(type, cols = 200, rows = 56) {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#0c0806;overflow:hidden';
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0';
  document.body.append(host);
  const options = {
    // Fill the window with exactly cols × rows cells.
    fontSize: Math.floor((innerWidth / cols / 0.6) * 100) / 100,
    lineHeight: (innerHeight / rows / Math.floor((innerWidth / cols / 0.6) * 100)) * 100,
    fontFamily: 'JetBrains Mono, monospace',
    theme: { background: '#0c0806', foreground: '#f2e6da', cursor: '#0c0806' },
    allowProposedApi: true,
  };
  const font = new FontFace('JetBrains Mono', 'url(/fonts/JetBrainsMono-Regular.ttf)');
  document.fonts.add(await font.load());
  const term = type === 'wraith' ? new WraithTerminal(options) : new Xterm(options);
  term.open(host);
  if (type === 'webgl') term.loadAddon(new WebglAddon());
  if (type === 'wraith') await term.webgpuReady;
  term.resize(cols, rows);
  const encoder = new TextEncoder();
  let variant = 0,
    updates = 0;
  const started = performance.now();
  const step = () =>
    term.write(showcase(term.cols, term.rows, variant++ % 8, encoder).bytes, () => {
      updates++;
      requestAnimationFrame(step);
    });
  step();
  window.rate = () => (updates / (performance.now() - started)) * 1000;
  window.grid = `${term.cols}x${term.rows}`;
}
