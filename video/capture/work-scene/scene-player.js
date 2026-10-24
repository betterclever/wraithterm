// Plays the mixed scene (length-prefixed frames) into one terminal. 'display': the
// next frame is written once the previous is shown and a display frame has passed
// (native: write, flush to its GPU fence, then a display frame). 'max': no display
// wait (native only). Frame 0 carries one-time setup and is not timed.
import { Terminal as Xterm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as WraithTerminal } from '../../../packages/wraith/src/xterm.ts';
import { Wraith } from '../../../packages/wraith/dist/index.js';
import '../../../packages/wraith/css/xterm.css';

export async function run(type, url, mode = 'display', seconds = 8, warm = 2) {
  const cols = 200,
    rows = 60;
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0';
  document.body.append(host);
  let frames = [];
  if (url.endsWith('.js')) {
    // A scene module builds its frames in the page, before timing.
    frames = await (await import(url)).build(window.SCENE_FRAMES ?? 480);
  } else {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const view = new DataView(bytes.buffer);
    for (let o = 0; o < bytes.length;) {
      const n = view.getUint32(o, true);
      frames.push(bytes.subarray(o + 4, o + 4 + n));
      o += 4 + n;
    }
  }
  const font = new FontFace('JetBrains Mono', 'url(/fonts/JetBrainsMono-Regular.ttf)');
  document.fonts.add(await font.load());
  const fontSize = Math.floor(Math.min(innerWidth / cols / 0.6, innerHeight / rows) * 100) / 100;
  const lineHeight = Math.min(2, Math.max(1, innerHeight / rows / fontSize));
  let write;
  if (type === 'native') {
    const term = await Wraith.mount(host, { cols, rows, fit: false, fontSize, lineHeight });
    write = async (data) => {
      await term.write(data);
      await term.flush();
      if (mode === 'display') await new Promise((r) => requestAnimationFrame(r));
    };
  } else {
    const options = {
      fontSize,
      lineHeight,
      fontFamily: 'JetBrains Mono, monospace',
      allowProposedApi: true,
    };
    const term = type === 'wraith' ? new WraithTerminal(options) : new Xterm(options);
    term.open(host);
    term.resize(cols, rows);
    if (type === 'webgl') term.loadAddon(new WebglAddon());
    if (type === 'wraith') await term.webgpuReady;
    write = (data) =>
      new Promise((done) => term.write(data, () => requestAnimationFrame(() => done())));
  }
  await write(frames[0]);
  const shown = [];
  const started = performance.now();
  for (let i = 1; performance.now() - started < (warm + seconds) * 1000; i++) {
    await write(frames[1 + ((i - 1) % (frames.length - 1))]);
    shown.push(performance.now() - started);
  }
  const steady = shown.filter((t) => t >= warm * 1000);
  return { fps: steady.length / ((steady.at(-1) - steady[0]) / 1000), frames: shown.length };
}
