import { Wraith } from '../packages/wraith/dist/index.js';
const $ = (id: string) => document.getElementById(id)!;
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const hash = (a: number, b = 0, c = 0) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15) ^ c, 0x27d4eb2f);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};
// The hero pauses while it is off screen, while the tab is hidden and during a race,
// so it never competes with the benchmark for the main thread or the GPU.
let heroVisible = true,
  racing = false,
  wake: (() => void) | undefined;
const heroActive = () => heroVisible && !racing && !document.hidden;
const resume = () => {
  if (heroActive()) wake?.();
};
document.addEventListener('visibilitychange', resume);

// Ember palette: warm black through wine and rust to amber, sampled as 0..1.
const stops = [
  [12, 8, 6],
  [24, 12, 11],
  [52, 20, 20],
  [104, 38, 30],
  [196, 92, 52],
  [255, 196, 138],
];
function palette(k: number, out: RGB) {
  const x = Math.min(0.9999, Math.max(0, k)) * (stops.length - 1);
  const i = x | 0,
    f = x - i,
    a = stops[i]!,
    b = stops[i + 1]!;
  out[0] = a[0]! + (b[0]! - a[0]!) * f;
  out[1] = a[1]! + (b[1]! - a[1]!) * f;
  out[2] = a[2]! + (b[2]! - a[2]!) * f;
}
type RGB = [number, number, number];

// The ghost: a little pixel spirit drawn in half-block cells of the same terminal. It follows
// the pointer with a springy lag and, when the pointer rests, wanders and settles beside the
// wordmark. 'o' marks the eyes; the last two rows are the wavy tail (two frames).
const GHOST = [
  '.....######.....',
  '...##########...',
  '..############..',
  '.##############.',
  '.###oo####oo###.',
  '####oo####oo####',
  '####oo####oo####',
  '################',
  '################',
  '################',
  '################',
  '################',
  '################',
  '################',
];
const TAIL = [
  ['##.###.###.###.#', '#...#...#...#...'],
  ['#.###.###.###.##', '..#...#...#...#.'],
];
const GHOST_W = 16,
  GHOST_H = GHOST.length + 2,
  GHOST_SCALE = 1.25;
const rain = [...'01λψΩΣπ∂∆≈≠{}<>/=+*#$%&░▒▓│┼╳◇'];

class Scene {
  cols = 0;
  rows = 0;
  mask = new Float32Array(0);
  glow = new Float32Array(0);
  mouse = { x: -1e4, y: -1e4 };
  /** Wall-clock time of the last pointer move; the ghost wanders off after a pause. */
  moved = -1e9;
  ghost = { x: -40, y: 0, vx: 0, vy: 0, homeX: 0, homeY: 0, tail: 0, lookX: 0, lookY: 0 };
  trail: { x: number; y: number }[] = [];
  aspect = 1.2;
  lastT = 0;
  bytes = 0;
  resize(cols: number, rows: number, cellWidth: number, cellHeight: number) {
    this.cols = cols;
    this.rows = rows;
    const w = cols,
      h = rows * 2;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    // Each half-block pixel is cellWidth wide and cellHeight/2 tall; pre-squash the
    // wordmark so it keeps its proportions on that grid.
    const aspect = cellWidth / (cellHeight / 2);
    this.aspect = aspect;
    const narrow = innerWidth < 1000;
    const centerX = w * (narrow ? 0.5 : 0.6),
      centerY = h * (narrow ? 0.2 : 0.19);
    const target = w * (narrow ? 0.9 : 0.6);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 100;
    ctx.font = `900 ${size}px Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif`;
    size = (size * target * aspect) / ctx.measureText('WRAITH').width;
    ctx.font = `900 ${size}px Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif`;
    ctx.setTransform(1 / aspect, 0, 0, 1, centerX, centerY);
    ctx.fillText('WRAITH', 0, 0);
    const alpha = ctx.getImageData(0, 0, w, h).data;
    this.mask = new Float32Array(w * h);
    let minX = w,
      maxX = 0,
      minY = h,
      maxY = 0;
    for (let i = 0; i < w * h; i++) {
      this.mask[i] = alpha[i * 4 + 3]! / 255;
      if (this.mask[i]! > 0.5) {
        const x = i % w,
          y = (i / w) | 0;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    // The ghost's resting place: just right of the wordmark, or under it when there is no room.
    const reach = (GHOST_W * GHOST_SCALE) / aspect / 2 + 4;
    if (maxX + reach * 2 < w - 2) {
      this.ghost.homeX = maxX + reach + 2;
      this.ghost.homeY = (minY + maxY) / 2;
    } else {
      this.ghost.homeX = (minX + maxX) / 2;
      this.ghost.homeY = maxY + (GHOST_H * GHOST_SCALE) / 2 + 6;
    }
    if (this.ghost.x < -30) {
      this.ghost.x = -30;
      this.ghost.y = h * 0.75;
    }
    // Separable box blur for the halo.
    const radius = 4,
      tmp = new Float32Array(w * h);
    this.glow = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++)
          s += this.mask[y * w + Math.min(w - 1, Math.max(0, x + k))]!;
        tmp[y * w + x] = s / (radius * 2 + 1);
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++)
          s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]!;
        this.glow[y * w + x] = s / (radius * 2 + 1);
      }
  }
  shade(px: number, py: number, t: number, out: RGB) {
    const w = this.cols;
    const ghost = this.ghost;
    const dx = (px - ghost.x) * this.aspect,
      dy = py - ghost.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const ripple = (Math.sin(d * 0.16 - t * 3.2) * 1.6) / (1 + d * 0.035);
    const v =
      Math.sin(px * 0.035 + t * 0.7) +
      Math.sin(py * 0.06 - t * 0.45) +
      Math.sin((px * 0.5 + py) * 0.03 + t * 0.35) +
      ripple;
    palette(0.12 + ((v + 4) / 8) ** 2.2 * 0.62 + 0.25 / (1 + d * 0.06), out);
    // Glitch: a few rows of the wordmark slip sideways for a moment.
    const slip = hash(py, Math.floor(t * 9)) < 0.035 ? Math.round((hash(py, 7) - 0.5) * 14) : 0;
    const sx = Math.min(w - 1, Math.max(0, px + slip));
    const m = this.mask[py * w + sx]!,
      g = this.glow[py * w + px]!;
    if (g > 0) {
      const halo = g * (0.55 + 0.15 * Math.sin(t * 2.1));
      out[0] += (255 - out[0]!) * halo * 0.55;
      out[1] += (150 - out[1]!) * halo * 0.55;
      out[2] += (96 - out[2]!) * halo * 0.55;
    }
    if (m > 0) {
      const scan = 0.78 + 0.22 * Math.sin(py * 0.9 - t * 7 + px * 0.02);
      const k = m * scan;
      out[0] += (255 - out[0]!) * k;
      out[1] += (238 - out[1]!) * k;
      out[2] += (218 - out[2]!) * k;
    }
    // Wisps left behind as the ghost flies.
    for (let i = 0; i < this.trail.length; i++) {
      const p = this.trail[i]!;
      const tx = (px - p.x) * this.aspect,
        ty = py - p.y;
      const r2 = tx * tx + ty * ty;
      if (r2 < 9) {
        const k = (1 - r2 / 9) * 0.35 * (1 - i / this.trail.length);
        out[0] += (255 - out[0]!) * k;
        out[1] += (214 - out[1]!) * k;
        out[2] += (190 - out[2]!) * k;
      }
    }
    // A warm glow around the ghost.
    const glow = 0.4 / (1 + d * d * 0.004);
    out[0] += (255 - out[0]!) * glow * 0.5;
    out[1] += (176 - out[1]!) * glow * 0.5;
    out[2] += (110 - out[2]!) * glow * 0.5;
    // The ghost itself, sampled from its sprite in square pixels.
    const gcol = Math.floor(dx / GHOST_SCALE + GHOST_W / 2),
      grow = Math.floor(dy / GHOST_SCALE + GHOST_H / 2);
    if (gcol < 0 || grow < 0 || gcol >= GHOST_W || grow >= GHOST_H) return;
    const row = grow < GHOST.length ? GHOST[grow]! : TAIL[ghost.tail]![grow - GHOST.length]!;
    let c = row[gcol];
    if (c === 'o') c = '#';
    if (c !== '#') return;
    // Eyes look where the ghost is heading.
    const ex = gcol - ghost.lookX,
      ey = grow - ghost.lookY;
    const eye = ey >= 4 && ey <= 6 && ((ex >= 4 && ex <= 5) || (ex >= 10 && ex <= 11));
    if (eye) {
      out[0] = 28;
      out[1] = 14;
      out[2] = 14;
      return;
    }
    const shine = grow < 3 ? 1 : 0.94 - 0.04 * Math.sin(t * 3 + grow * 0.5);
    out[0] += (255 * shine - out[0]!) * 0.9;
    out[1] += (246 * shine - out[1]!) * 0.9;
    out[2] += (236 * shine - out[2]!) * 0.9;
  }
  /** Spring the ghost toward the pointer, or wander and settle at home when it rests. */
  move(t: number) {
    const dt = Math.min(0.05, Math.max(0, t - this.lastT));
    this.lastT = t;
    const g = this.ghost;
    const idle = (performance.now() - this.moved) / 1000;
    let tx: number, ty: number;
    if (idle < 2 && this.mouse.x > -1e3) {
      // Hover just up and to the left of the pointer, never under it.
      tx = this.mouse.x - 14 / this.aspect;
      ty = this.mouse.y - 10;
    } else {
      const roam = Math.max(0, 1 - Math.max(0, idle - 2) / 4);
      tx = g.homeX + Math.sin(t * 0.9) * 26 * roam;
      ty = g.homeY + Math.sin(t * 1.4) * 12 * roam + Math.sin(t * 2.2) * 1.5;
    }
    const k = 22,
      damping = 6.5;
    g.vx += ((tx - g.x) * k - g.vx * damping) * dt;
    g.vy += ((ty - g.y) * k - g.vy * damping) * dt;
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    g.tail = Math.floor(t * 6) % 2;
    g.lookX = Math.max(-1, Math.min(1, Math.round(g.vx / 25)));
    g.lookY = Math.max(-1, Math.min(1, Math.round(g.vy / 25)));
    if (Math.hypot(g.vx, g.vy) > 6) this.trail.unshift({ x: g.x, y: g.y + 6 });
    if (this.trail.length > 10 || (this.trail.length && Math.hypot(g.vx, g.vy) <= 6))
      this.trail.pop();
  }
  frame(t: number) {
    this.move(t);
    const { cols, rows } = this;
    const top: RGB = [0, 0, 0],
      bottom: RGB = [0, 0, 0];
    const parts: string[] = [];
    let fg = -1,
      bg = -1;
    for (let y = 0; y < rows; y++) {
      parts.push(`\x1b[${y + 1};1H`);
      for (let x = 0; x < cols; x++) {
        this.shade(x, y * 2, t, top);
        this.shade(x, y * 2 + 1, t, bottom);
        // Glyph rain in a third of the columns, kept out of the wordmark's halo.
        const lane = hash(x, 3);
        let char = '▀';
        let f = (top[0]! << 16) | (top[1]! << 8) | top[2]!;
        let b = (bottom[0]! << 16) | (bottom[1]! << 8) | bottom[2]!;
        if (lane < 0.33 && this.glow[y * 2 * cols + x]! < 0.02) {
          const span = rows + 24;
          const head = (t * (6 + lane * 40) + hash(x, 9) * span) % span;
          const age = head - y;
          if (age >= 0 && age < 18) {
            const k = age < 1 ? 1 : 0.75 * (1 - age / 18);
            char = rain[Math.floor(hash(x, y, Math.floor(t * (age < 1 ? 20 : 3))) * rain.length)]!;
            b =
              (((top[0]! + bottom[0]!) >> 1) << 16) |
              (((top[1]! + bottom[1]!) >> 1) << 8) |
              ((top[2]! + bottom[2]!) >> 1);
            const r = age < 1 ? 255 : 240 * k + 24,
              gg = age < 1 ? 236 : 150 * k + 16,
              bb = age < 1 ? 210 : 84 * k + 12;
            f = (r << 16) | (gg << 8) | bb;
          }
        }
        // Quantize to 4-level steps; neighbours then often share a color and skip the SGR.
        f &= 0xfcfcfc;
        b &= 0xfcfcfc;
        if (f !== fg && b !== bg)
          parts.push(
            `\x1b[38;2;${f >>> 16};${(f >>> 8) & 255};${f & 255};48;2;${b >>> 16};${(b >>> 8) & 255};${b & 255}m`,
          );
        else if (f !== fg) parts.push(`\x1b[38;2;${f >>> 16};${(f >>> 8) & 255};${f & 255}m`);
        else if (b !== bg) parts.push(`\x1b[48;2;${b >>> 16};${(b >>> 8) & 255};${b & 255}m`);
        fg = f;
        bg = b;
        parts.push(char);
      }
    }
    const frame = parts.join('');
    // ▀ and the rain glyphs are three UTF-8 bytes; everything else is ASCII.
    this.bytes = frame.length + cols * rows * 2;
    return frame;
  }
}

async function hero() {
  const host = $('hero-term');
  new IntersectionObserver(([entry]) => {
    heroVisible = entry!.isIntersecting;
    resume();
  }).observe(host);
  let term: Wraith;
  try {
    term = await Wraith.mount(host, {
      fontSize: 11,
      lineHeight: 1,
      scrollback: 100,
      theme: { background: '#0c0806', foreground: '#ffb86b', cursor: '#0c0806' },
    });
  } catch (error) {
    $('hud-state').textContent = 'offline';
    $('hud-adapter').textContent =
      `${error instanceof Error ? error.message : error} The page still works; the hero needs WebGPU.`;
    return;
  }
  $('hud-state').textContent = 'WebGPU';
  term.onStats((stats) => {
    $('hud-p50').textContent = `${stats.renderP50Ms.toFixed(2)} ms`;
    $('hud-fps').textContent = String(stats.activeFps);
    if (stats.adapter)
      $('hud-adapter').textContent = `${stats.adapter} · libghostty-vt in a worker`;
  });
  const scene = new Scene();
  const layout = () => {
    const box = host.getBoundingClientRect();
    scene.resize(term.cols, term.rows, box.width / term.cols, box.height / term.rows);
    $('hud-grid').textContent = `${term.cols}×${term.rows}`;
    $('hud-cells').textContent = (term.cols * term.rows).toLocaleString();
  };
  layout();
  term.onResize(layout);
  const hero = host.parentElement!;
  hero.addEventListener('pointermove', (event) => {
    const box = host.getBoundingClientRect();
    scene.mouse.x = ((event.clientX - box.left) / box.width) * scene.cols;
    scene.mouse.y = ((event.clientY - box.top) / box.height) * scene.rows * 2;
    scene.moved = performance.now();
  });
  hero.addEventListener('pointerleave', () => {
    scene.mouse.x = scene.mouse.y = -1e4;
  });
  await term.write('\x1b[?25l\x1b[2J');
  const start = performance.now();
  for (;;) {
    if (!heroActive()) {
      await new Promise<void>((resolve) => (wake = resolve));
      continue;
    }
    const t = reduced ? 4 : (performance.now() - start) / 1000;
    try {
      await term.write(scene.frame(t));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    $('hud-bytes').textContent = `${(scene.bytes / 1024).toFixed(0)} KiB`;
    if (reduced) await new Promise<void>((resolve) => (wake = resolve));
    await nextFrame();
  }
}

// Numbers: bars grow when they scroll into view.
const bars = $('bars');
new IntersectionObserver(
  ([entry], observer) => {
    if (!entry!.isIntersecting) return;
    const rows = [...bars.querySelectorAll<HTMLElement>('.bar-row')];
    const max = Math.max(...rows.map((row) => Number(row.dataset.ms)));
    rows.forEach((row, i) =>
      setTimeout(() => {
        row.querySelector<HTMLElement>('i')!.style.width =
          `${(Number(row.dataset.ms) / max) * 100}%`;
      }, i * 160),
    );
    observer.disconnect();
  },
  { threshold: 0.4 },
).observe(bars);

// Race: the repository's benchmark harness, one renderer at a time, in a same-origin frame.
interface Lane {
  type: 'dom' | 'webgl' | 'wraith' | 'ghostty';
  name: string;
  detail: string;
  ours?: boolean;
}
const lanes: Lane[] = [
  { type: 'dom', name: 'xterm.js', detail: 'DOM renderer' },
  { type: 'webgl', name: 'xterm.js', detail: '+ WebGL addon' },
  { type: 'wraith', name: 'Wraith', detail: 'xterm-compatible', ours: true },
  { type: 'ghostty', name: 'Wraith', detail: 'native · libghostty', ours: true },
];
interface Comparison {
  ready: Promise<unknown>;
  run(config: object): Promise<{
    pipelineUpdatesPerSecond: number;
    pipelineCpuMs: { p50: number };
  }>;
  dispose(): void;
}
const stage = $('stage'),
  board = $('race-board'),
  status = $('race-status');
stage.innerHTML = '<div class="stage-empty">The real benchmark scene renders here.</div>';
function renderBoard(selected: Lane[]) {
  board.innerHTML = selected
    .map(
      (lane) =>
        `<div class="lane${lane.ours ? ' ours' : ''}" data-type="${lane.type}"><span class="who">${lane.name}<small>${lane.detail}</small></span><div class="track"><i></i></div><span class="num ms">—<small>ms per update</small></span><span class="num cpu">—<small>CPU p50</small></span></div>`,
    )
    .join('');
}
renderBoard(lanes.slice(1));
$('race-dom').addEventListener('change', (event) => {
  if (!racing) renderBoard(lanes.slice((event.target as HTMLInputElement).checked ? 0 : 1));
});
function scaleStage(frame: HTMLIFrameElement) {
  frame.style.transform = `scale(${stage.clientWidth / 2200})`;
}
addEventListener('resize', () => {
  const frame = stage.querySelector('iframe');
  if (frame) scaleStage(frame);
});
async function contestant(lane: Lane, workload: string) {
  stage.querySelector('.stage-empty')?.remove();
  stage.querySelector('iframe')?.remove();
  const frame = document.createElement('iframe');
  frame.title = `${lane.name} ${lane.detail} benchmark`;
  frame.src = `/compare.html?type=${lane.type}&workload=${workload}`;
  scaleStage(frame);
  const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
  stage.append(frame);
  await loaded;
  const win = frame.contentWindow as Window & { comparison?: Comparison; failure?: string };
  const style = win.document.createElement('style');
  style.textContent = 'header,#result{display:none!important}main{padding:0!important}';
  win.document.head.append(style);
  while (!win.comparison?.ready) await nextFrame();
  await win.comparison.ready;
  if (win.failure) throw new Error(win.failure);
  const result = await win.comparison.run({
    type: lane.type,
    workload,
    cols: 240,
    rows: 80,
    frames: lane.type === 'dom' ? 64 : 128,
  });
  return { ms: 1000 / result.pipelineUpdatesPerSecond, cpu: result.pipelineCpuMs.p50 };
}
$('race-go').addEventListener('click', async () => {
  const button = $('race-go') as HTMLButtonElement;
  const workload = ($('race-workload') as HTMLSelectElement).value;
  const selected = lanes.slice(($('race-dom') as HTMLInputElement).checked ? 0 : 1);
  button.disabled = true;
  racing = true;
  renderBoard(selected);
  const results = new Map<string, { ms: number; cpu: number }>();
  const stageBox = stage.parentElement!;
  stageBox.classList.add('running');
  try {
    for (const lane of selected) {
      const row = board.querySelector<HTMLElement>(`[data-type="${lane.type}"]`)!;
      row.classList.add('active');
      $('stage-name').textContent = `${lane.name} ${lane.detail} · running`;
      status.textContent = `Running ${lane.name} (${lane.detail})…`;
      try {
        const result = await contestant(lane, workload);
        results.set(lane.type, result);
        row.querySelector('.ms')!.innerHTML = `${result.ms.toFixed(2)}<small>ms per update</small>`;
        row.querySelector('.cpu')!.innerHTML = `${result.cpu.toFixed(2)}<small>ms CPU p50</small>`;
      } catch (error) {
        row.querySelector('.ms')!.innerHTML = `failed<small>${String(error).slice(0, 40)}</small>`;
      }
      row.classList.remove('active');
      row.classList.add('done');
      const max = Math.max(...[...results.values()].map((r) => r.ms));
      for (const [type, r] of results)
        board.querySelector<HTMLElement>(`[data-type="${type}"] i`)!.style.width =
          `${(r.ms / max) * 100}%`;
    }
    const webgl = results.get('webgl');
    const ours = ['wraith', 'ghostty']
      .map((type) => results.get(type))
      .filter((r): r is { ms: number; cpu: number } => !!r);
    board.querySelector('.verdict')?.remove();
    if (webgl && ours.length) {
      const best = Math.min(...ours.map((r) => r.ms));
      const verdict = document.createElement('p');
      verdict.className = 'verdict';
      verdict.innerHTML =
        best < webgl.ms
          ? `On your machine, Wraith finished each update <em>${(webgl.ms / best).toFixed(1)}×</em> faster than xterm WebGL.`
          : `On your machine, xterm WebGL kept up this time (${webgl.ms.toFixed(2)} vs ${best.toFixed(2)} ms). Rerun to check for noise.`;
      board.append(verdict);
    }
    status.textContent = 'Done. Each update rewrites the full 240×80 screen and waits for the GPU.';
  } finally {
    stageBox.classList.remove('running');
    $('stage-name').textContent = 'Stage idle';
    button.disabled = false;
    racing = false;
    resume();
  }
});

void hero();
