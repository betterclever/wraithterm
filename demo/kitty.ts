// The Kitty graphics lab: a live developer workspace drawn in one native Wraith
// terminal, with a PNG chart and a site preview sent through the Kitty graphics
// protocol on every frame.
import { Wraith } from '../packages/wraith/dist/index.js';
import { COLS, ROWS, createScene } from './kitty-scene.js';

const $ = (id: string) => document.getElementById(id)!;
let term: Wraith;
let running = true;

async function boot() {
  try {
    const host = $('terminal');
    // The workspace is laid out for 200×60; size the font so it fits the window.
    // Cells round up to whole device pixels, so leave headroom.
    const fontSize = Math.max(
      6.5,
      Math.min(14, Math.floor((host.clientWidth / COLS / 0.63) * 10) / 10),
    );
    term = await Wraith.mount(host, {
      cols: COLS,
      rows: ROWS,
      fit: false,
      fontSize,
      lineHeight: 1.25,
      theme: { foreground: '#e8e0d6', background: '#0d0a08', cursor: '#0d0a08' },
    });
    $('status').innerHTML = '<i></i> WebGPU online';
    $('grid').textContent = `${COLS} × ${ROWS}`;
    term.onError((error) => {
      $('status').classList.add('error');
      $('status').textContent = error.message;
    });
    term.onStats((stats) => {
      $('adapter').textContent = `${stats.adapter || 'WebGPU adapter'} · libghostty-vt in a worker`;
    });
    const scene = await createScene('/labs/kitty-preview.jpg');
    await term.write(scene.setup());
    $('pause').onclick = () => {
      running = !running;
      $('pause').textContent = running ? 'Pause' : 'Resume';
      if (running) loop();
    };
    for (const [id, key, image] of [
      ['chart', 'chart', 2],
      ['preview', 'preview', 3],
    ] as const) {
      $(id).onclick = async () => {
        scene.options[key] = !scene.options[key];
        $(id).classList.toggle('primary', scene.options[key]);
        if (!scene.options[key]) await term.write(scene.erase(image));
      };
    }
    let frames = 0,
      buildMs = 0,
      since = performance.now();
    const started = performance.now();
    const loop = async () => {
      let next = scene.frame((performance.now() - started) / 1000);
      while (running) {
        const before = performance.now();
        const data = await next;
        buildMs += performance.now() - before;
        // Build the next frame while Wraith parses this one; then wait for a
        // display frame, like an app drawing at the display's rate.
        next = scene.frame((performance.now() - started) / 1000 + 1 / 120);
        await term.write(data);
        await new Promise((r) => requestAnimationFrame(r));
        frames++;
        const now = performance.now();
        if (now - since > 500) {
          const seconds = (now - since) / 1000;
          $('fps').innerHTML = `${Math.round(frames / seconds)}<small>/s</small>`;
          $('mbps').innerHTML =
            `${(scene.takeImageBytes() / seconds / 2 ** 20).toFixed(0)}<small>MB/s</small>`;
          $('build').innerHTML = `${(buildMs / frames).toFixed(1)}<small>ms</small>`;
          frames = 0;
          buildMs = 0;
          since = now;
        }
      }
    };
    loop();
  } catch (error) {
    $('status').classList.add('error');
    $('status').textContent = error instanceof Error ? error.message : String(error);
  }
}
boot();
