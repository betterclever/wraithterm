// Fleet: a thousand live Wraith terminals streaming agent logs in one tab.
// With `surface: 'shared'` each pool worker draws all of its terminals into one
// page-sized WebGPU canvas; per-canvas mode gives every terminal its own.
// window.fleet exposes start/stop/metrics/view for the browser test and benchmark.
import { Wraith } from '../packages/wraith/dist/index.js';

const encoder = new TextEncoder();
/** Two coloured agent-log lines and a rewritten status row (demo/rival-bench.js). */
export function logUpdate(id, n) {
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

const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const $ = (id) => document.getElementById(id);
const view = { x: 0, y: 0, z: 1 };
/** Write a readout only when its text changes. */
function show(id, text) {
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
}
function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  show('r-zoom', `${(view.z * 100).toFixed(view.z < 0.1 ? 1 : 0)}%`);
}
// The grid sits below the HUD. Its height is fixed by CSS for a given window
// width, so measure it at load and on resize only, never as readouts change.
let hudInset = 0;
function measureHud() {
  hudInset = document.querySelector('.hud').getBoundingClientRect().bottom + 8;
}
measureHud();
function fit() {
  const top = hudInset;
  const w = world.offsetWidth,
    h = world.offsetHeight;
  if (!w || !h) return;
  view.z = Math.min((innerWidth - 24) / w, (innerHeight - top - 36) / h);
  view.x = (innerWidth - w * view.z) / 2;
  view.y = top + (innerHeight - top - 36 - h * view.z) / 2;
  applyView();
}
function zoomAt(cx, cy, z) {
  z = Math.min(4, Math.max(0.01, z));
  view.x = cx - ((cx - view.x) * z) / view.z;
  view.y = cy - ((cy - view.y) * z) / view.z;
  view.z = z;
  applyView();
}

class Fleet {
  terms = [];
  pool = undefined;
  running = false;
  acked = [];
  rendered = [];
  frames = 0;
  longTasks = { count: 0, ms: 0 };
  /** Long Animation Frames (>50 ms): count, durations, and time per phase and
   * per attributed script, cumulative. */
  loaf = { count: 0, ms: 0, blockingMs: 0, renderMs: 0, styleLayoutMs: 0, scripts: {} };
  pace = 'frame';
  feed = 'main';
  mountMs = 0;
  errors = [];
  async start({
    count = 1000,
    mode = 'shared',
    workers = 4,
    cols = 80,
    rows = 24,
    fontSize = 7,
    lineHeight = 1.2,
    pace = 'frame',
    scrollback = 1000,
    feed = 'main',
    // Per-terminal stats cost a message per terminal every 500 ms; shared
    // pools report drawn updates per worker instead.
    terminalStats = mode !== 'shared',
  } = {}) {
    await this.stop();
    this.pace = pace;
    this.feed = mode === 'shared' && feed === 'worker' ? 'worker' : 'main';
    $('count').value = String(count);
    $('mode').value = mode;
    $('pace').value = pace;
    const font = new Uint8Array(
      await (await fetch('/fonts/JetBrainsMono-Regular.ttf')).arrayBuffer(),
    );
    this.pool = Wraith.pool({ workers, surface: mode });
    this.terminalStats = terminalStats;
    const options = {
      cols,
      rows,
      fit: false,
      fontSize,
      lineHeight,
      font,
      scrollback,
      pool: this.pool,
    };
    const started = performance.now();
    const mountOne = async (i) => {
      const host = document.createElement('div');
      host.className = 'tile';
      world.append(host);
      const term = await Wraith.mount(host, options);
      term.onError((error) => this.errors.push(`${i}: ${error.message}`));
      if (terminalStats) term.onStats((stats) => (this.rendered[i] = stats.frames));
      return term;
    };
    // The first terminal sizes the grid; the rest mount in bounded batches.
    const first = await mountOne(0);
    const w = parseFloat(first.canvas.style.width),
      h = parseFloat(first.canvas.style.height);
    const across = Math.max(1, Math.round(Math.sqrt((count * (innerWidth / innerHeight) * h) / w)));
    world.style.gridTemplateColumns = `repeat(${across}, ${w}px)`;
    world.style.gridAutoRows = `${h}px`;
    fit();
    this.terms = [first];
    for (let i = 1; i < count; i += 64) {
      const batch = [];
      for (let j = i; j < Math.min(count, i + 64); j++) batch.push(mountOne(j));
      this.terms.push(...(await Promise.all(batch)));
      show('r-terminals', `${this.terms.length} / ${count}`);
    }
    this.mountMs = performance.now() - started;
    this.acked = new Array(count).fill(0);
    this.rendered = new Array(count).fill(0);
    show('r-terminals', String(count));
    fit();
    this.running = true;
    // Display frames: main-thread animation frames, whatever feeds the terminals.
    const frame = () => {
      if (!this.running) return;
      this.frames++;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    if (this.feed === 'worker') await this.feedWorkers();
    else this.drive();
    return { mountMs: this.mountMs, count, feed: this.feed };
  }
  /** One animation-frame driver: every terminal whose previous update was
   * parsed writes its next one, at most once per display frame (or at `pace`). */
  drive() {
    const inflight = new Uint8Array(this.terms.length);
    const last = new Float64Array(this.terms.length);
    const sequence = new Uint32Array(this.terms.length);
    const tick = (now) => {
      if (!this.running) return;
      const interval =
        this.pace === 'frame' ? 0 : this.pace === '0' ? Infinity : 1000 / Number(this.pace);
      for (let i = 0; i < this.terms.length; i++) {
        if (inflight[i] || now - last[i] < interval) continue;
        inflight[i] = 1;
        last[i] = now;
        this.terms[i]
          .write(logUpdate(i, sequence[i]++))
          .then(() => {
            inflight[i] = 0;
            this.acked[i]++;
          })
          .catch(() => (inflight[i] = 0));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  /** Worker-fed: each pool worker replays its terminals' updates itself, one
   * per terminal per worker animation frame; nothing crosses the main thread
   * while they stream. (Internal benchmark command; see protocol.ts 'feed'.) */
  async feedWorkers() {
    const cycle = 64;
    await Promise.all(
      this.terms.map((term, i) =>
        term.request({
          type: 'feed',
          chunks: Array.from({ length: cycle }, (_, n) => logUpdate(i, n)),
        }),
      ),
    );
  }
  /** Cumulative counters; callers difference two snapshots. */
  async metrics() {
    if (this.feed === 'worker' && this.running)
      this.acked = await Promise.all(
        this.terms.map((term) => term.request({ type: 'feed' }).catch(() => 0)),
      );
    const surfaces = this.pool?.surfaceStats ?? [];
    const sum = (key) => surfaces.reduce((a, s) => a + (s?.[key] ?? 0), 0);
    return {
      time: performance.now(),
      frames: this.frames,
      acked: [...this.acked],
      rendered: [...this.rendered],
      longTasks: { ...this.longTasks },
      loaf: { ...this.loaf, scripts: { ...this.loaf.scripts } },
      surfaceFrames: surfaces.map((s) => s?.frames ?? 0),
      surfaceCompletedFrames: surfaces.map((s) => s?.completedFrames ?? 0),
      surfaceUpdates: sum('updates'),
      terminalStats: this.terminalStats,
      surfaceCompletedUpdates: sum('completedUpdates'),
      atlases: surfaces.map((s) => s?.atlases ?? 0),
      errors: [...this.errors],
    };
  }
  async stop() {
    this.running = false;
    await Promise.all(this.terms.map((t) => t.dispose().catch(() => {})));
    this.terms = [];
    this.pool?.dispose();
    this.pool = undefined;
    world.replaceChildren();
  }
}
const fleet = (window.fleet = new Fleet());
window.Wraith = Wraith;
window.fleetView = {
  get: () => ({ ...view }),
  set(x, y, z) {
    Object.assign(view, { x, y, z });
    applyView();
  },
  fit,
};
if (typeof PerformanceObserver !== 'undefined')
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        fleet.longTasks.count++;
        fleet.longTasks.ms += entry.duration;
      }
    }).observe({ type: 'longtask' });
  } catch {
    // Long-task timing is unavailable outside Chromium.
  }
// What stalled a frame: Long Animation Frames with script attribution.
if (typeof PerformanceObserver !== 'undefined')
  try {
    new PerformanceObserver((list) => {
      const loaf = fleet.loaf;
      for (const entry of list.getEntries()) {
        loaf.count++;
        loaf.ms += entry.duration;
        loaf.blockingMs += entry.blockingDuration ?? 0;
        const end = entry.startTime + entry.duration;
        if (entry.renderStart) loaf.renderMs += end - entry.renderStart;
        if (entry.styleAndLayoutStart) loaf.styleLayoutMs += end - entry.styleAndLayoutStart;
        for (const script of entry.scripts ?? []) {
          const file = String(script.sourceURL ?? '')
            .split('/')
            .pop()
            .split('?')[0];
          const key = `${script.invokerType}:${script.invoker} ${script.sourceFunctionName || '(anonymous)'} ${file}`;
          loaf.scripts[key] = (loaf.scripts[key] ?? 0) + script.duration;
        }
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch {
    // Long Animation Frames are Chromium-only.
  }

// Live readout, from differences between half-second snapshots.
let previous = await fleet.metrics();
setInterval(async () => {
  const now = await fleet.metrics();
  const seconds = (now.time - previous.time) / 1000;
  if (fleet.terms.length && now.acked.length === previous.acked.length && seconds > 0) {
    const updates =
      now.acked.reduce((a, b) => a + b, 0) - previous.acked.reduce((a, b) => a + b, 0);
    show('r-fps', ((now.frames - previous.frames) / seconds).toFixed(0));
    show('r-updates', Math.round(updates / seconds).toLocaleString());
    show('r-per', (updates / seconds / fleet.terms.length).toFixed(1));
    const shared = fleet.pool?.surface === 'shared';
    show(
      'r-gpu',
      shared
        ? Math.round(
            (now.surfaceCompletedUpdates - previous.surfaceCompletedUpdates) / seconds,
          ).toLocaleString()
        : 'n/a',
    );
    // Slowest–fastest worker, so the width does not grow with the worker count.
    const rates = now.surfaceFrames.map((f, i) => (f - (previous.surfaceFrames[i] ?? 0)) / seconds);
    show(
      'r-surface',
      shared && rates.length
        ? `${Math.min(...rates).toFixed(0)}–${Math.max(...rates).toFixed(0)}`
        : `${fleet.terms.length} canvases`,
    );
    show(
      'r-long',
      `${now.longTasks.count - previous.longTasks.count} · ${(now.longTasks.ms - previous.longTasks.ms).toFixed(0)} ms`,
    );
  }
  previous = now;
}, 500);

// Wheel zooms around the pointer; dragging pans. Zoomed in near actual size,
// drags that start on a terminal select its text instead (hold Space to pan).
let space = false,
  pan;
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLTextAreaElement) return;
  if (e.code === 'Space') space = true;
  if (e.key === 'f' || e.key === 'F') fit();
  if (e.key === '1') zoomAt(innerWidth / 2, innerHeight / 2, 1);
});
addEventListener('keyup', (e) => e.code === 'Space' && (space = false));
viewport.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, view.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  },
  { passive: false },
);
viewport.addEventListener(
  'pointerdown',
  (e) => {
    const onTerminal = e.target instanceof HTMLCanvasElement;
    if (onTerminal && view.z >= 0.75 && !space && e.button === 0) return;
    e.stopPropagation();
    e.preventDefault();
    pan = { id: e.pointerId, x: e.clientX - view.x, y: e.clientY - view.y };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('panning');
  },
  { capture: true },
);
viewport.addEventListener('pointermove', (e) => {
  if (!pan || e.pointerId !== pan.id) return;
  view.x = e.clientX - pan.x;
  view.y = e.clientY - pan.y;
  applyView();
});
const endPan = (e) => {
  if (!pan || e.pointerId !== pan.id) return;
  pan = undefined;
  viewport.classList.remove('panning');
};
viewport.addEventListener('pointerup', endPan);
viewport.addEventListener('pointercancel', endPan);
viewport.addEventListener('dblclick', (e) => {
  const tile = e.target instanceof Element && e.target.closest('.tile');
  if (!tile) return;
  // Zoom so the terminal fills about half the window, centred.
  const r = tile.getBoundingClientRect();
  const z = Math.min(4, (view.z * Math.min(innerWidth, innerHeight * 1.6) * 0.5) / r.width);
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, z);
  const c = tile.getBoundingClientRect();
  view.x += innerWidth / 2 - (c.left + c.width / 2);
  view.y += innerHeight / 2 - (c.top + c.height / 2);
  applyView();
});
addEventListener('resize', () => {
  measureHud();
  if (fleet.terms.length) fit();
});

const params = new URLSearchParams(location.search);
for (const [id, key] of [
  ['count', 'count'],
  ['mode', 'mode'],
  ['pace', 'pace'],
]) {
  const select = $(id);
  if (params.has(key)) select.value = params.get(key);
  select.addEventListener('change', () => {
    if (id === 'pace') {
      fleet.pace = select.value;
      params.set('pace', select.value);
      history.replaceState(null, '', `?${params}`);
      return;
    }
    params.set(key, select.value);
    location.search = params.toString();
  });
}
$('fit').addEventListener('click', fit);
$('actual').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1));
applyView();
if (params.get('auto') !== '0')
  fleet
    .start({
      count: Number($('count').value),
      mode: $('mode').value,
      pace: $('pace').value,
      workers: Number(params.get('workers') ?? 4),
      feed: params.get('feed') ?? 'main',
    })
    .catch((error) => {
      $('hint').textContent = `Could not start: ${error.message}`;
      console.error(error);
    });
