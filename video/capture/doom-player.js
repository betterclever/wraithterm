// Plays a recorded doomterm stream (DOOM's own terminal output) into xterm.js or
// Wraith. 'paced' shows game time at 35 Hz and drops frames a terminal cannot keep
// up with, as a game would; 'max' writes each frame as soon as the previous one
// is shown (a timedemo). A frame counts once the terminal has processed it and a
// display frame has passed (native: after flush(), which waits for the GPU fence).
// Loaded through the demo's Vite server.
import { Terminal as Xterm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as WraithTerminal } from '../../packages/wraith/src/xterm.ts';
import { Wraith } from '../../packages/wraith/dist/index.js';
import '../../packages/wraith/css/xterm.css';

/** Split at each frame's cursor-home (ESC [ H), keeping the setup prefix in frame 0. */
function split(bytes) {
  const starts = [];
  for (let i = 0; i + 2 < bytes.length; i++)
    if (bytes[i] === 27 && bytes[i + 1] === 91 && bytes[i + 2] === 72) starts.push(i);
  return starts.map((s, n) => bytes.subarray(n ? s : 0, starts[n + 1] ?? bytes.length));
}

export async function run(type, url, cols, rows, mode = 'paced', seconds = 10) {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0';
  document.body.append(host);
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const frames = split(bytes);
  const font = new FontFace('JetBrains Mono', 'url(/fonts/JetBrainsMono-Regular.ttf)');
  document.fonts.add(await font.load());
  // The same font and cell geometry for every terminal, fitting the viewport.
  const fontSize = Math.floor(Math.min(innerWidth / cols / 0.6, innerHeight / rows) * 100) / 100;
  const lineHeight = Math.min(2, Math.max(1, innerHeight / rows / fontSize));
  const options = {
    fontSize,
    lineHeight,
    fontFamily: 'JetBrains Mono, monospace',
    theme: { background: '#000000' },
    allowProposedApi: true,
  };
  let write;
  if (type === 'native') {
    const term = await Wraith.mount(host, { cols, rows, fit: false, fontSize, lineHeight });
    write = async (data) => {
      await term.write(data);
      await term.flush();
    };
  } else {
    const term = type === 'wraith' ? new WraithTerminal(options) : new Xterm(options);
    term.open(host);
    term.resize(cols, rows);
    // xterm.js rounds cells to device pixels; shrink until the grid fits too.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cell = term._core._renderService.dimensions.css.cell;
      if (!cell.width || !cell.height) continue;
      const scale = Math.min(innerWidth / (cols * cell.width), innerHeight / (rows * cell.height));
      if (scale >= 1) break;
      term.options.fontSize = Math.floor(term.options.fontSize * Math.max(scale, 0.9) * 100) / 100;
    }
    // Load the GPU renderer only once the font is final, so its atlas and
    // viewport are built for the geometry that is measured.
    if (type === 'webgl') term.loadAddon(new WebglAddon());
    if (type === 'wraith') await term.webgpuReady;
    window.xterm = term;
    write = (data) =>
      new Promise((done) => term.write(data, () => requestAnimationFrame(() => done())));
  }
  window.geometry = () => {
    const c = document.querySelector('canvas');
    return c ? c.getBoundingClientRect().toJSON() : null;
  };
  await write(frames[0]);
  const shown = [];
  let playing = true;
  const started = performance.now();
  window.stop = () => (playing = false);
  window.doom = { shown, indices: [], frames: frames.length, started, mode, done: false };
  // Show one recorded frame and wait until it has been drawn, for stills.
  window.showFrame = async (index) => {
    playing = false;
    await write(frames[index]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
  (async () => {
    let next = 1;
    while (playing && performance.now() - started < seconds * 1000) {
      let frame;
      if (mode === 'paced') {
        // Game time picks the frame; frames the terminal missed are dropped.
        frame = 1 + (Math.floor(((performance.now() - started) / 1000) * 35) % (frames.length - 1));
        if (frame === next - 1) {
          await new Promise((r) => requestAnimationFrame(r));
          continue;
        }
        next = frame + 1;
      } else {
        frame = 1 + ((next++ - 1) % (frames.length - 1));
      }
      await write(frames[frame]);
      shown.push(performance.now() - started);
      window.doom.indices.push(frame);
    }
    window.doom.done = true;
  })();
}
