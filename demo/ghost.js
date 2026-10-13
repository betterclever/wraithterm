import { Wraith } from '../packages/wraith/dist/index.js';
const $ = (id) => document.getElementById(id);
const film = new URLSearchParams(location.search).has('film');
if (film) document.body.classList.add('film');
const worker = new Worker(new URL('./ghost-worker.js', import.meta.url), {
  type: 'module',
  name: 'Ghost reactor scene',
});
let terminal,
  current,
  disposed = false,
  busy = false,
  running = false,
  version = 0,
  id = 0,
  animation = 0,
  lastClock = performance.now(),
  sampleAt = performance.now(),
  completed = 0,
  raf = 0,
  pending;
const input = {};
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const status = (s) => {
  $('status').textContent = s;
};
const lab = { ready: false, error: null, frames: 0, time: 0, stats: null };
window.ghostLab = lab;
worker.onmessage = ({ data }) => {
  if (!pending || pending.id !== data.id) return;
  const p = pending;
  clearTimeout(p.timer);
  pending = undefined;
  if (data.error) p.reject(new Error(data.error));
  else p.resolve(data);
};
worker.onerror = (e) => fail(new Error(e.message || 'Scene worker failed'));
worker.onmessageerror = () => fail(new Error('Scene worker reply could not be decoded'));
function generate(t) {
  if (pending) return Promise.reject(new Error('A scene frame is already in flight'));
  return new Promise((resolve, reject) => {
    const request = ++id;
    const timer = setTimeout(() => {
      if (pending?.id !== request) return;
      pending = undefined;
      reject(new Error('Scene generation timed out after 10 seconds'));
    }, 10_000);
    pending = { id: request, resolve, reject, timer };
    worker.postMessage({ id, cols: terminal.cols, rows: terminal.rows, time: t, input });
  });
}
function fail(error) {
  lab.error = String(error);
  lab.ready = false;
  running = false;
  cancelAnimationFrame(raf);
  status(lab.error);
  clearTimeout(pending?.timer);
  pending?.reject(error);
  pending = undefined;
  for (const key of ['pause', 'restart', 'pulse']) $(key).disabled = true;
}
function advance(now) {
  if (running && !document.hidden)
    animation += ((now - lastClock) / 1000) * Number($('speed').value);
  lastClock = now;
}
async function present(t) {
  if (busy || disposed || !terminal) throw new Error('Reactor is busy');
  busy = true;
  const token = version,
    target = terminal;
  try {
    const frame = await generate(t);
    if (token !== version) return;
    await target.write(frame.bytes);
    await target.flush();
    if (token !== version) return;
    current = frame;
    lab.frames++;
    lab.time = t;
    lab.stats = {
      generationMs: frame.generationMs,
      bytes: frame.bytes.length,
      sgrChanges: frame.sgrChanges,
      particles: frame.particles,
    };
    completed++;
    const now = performance.now();
    if (now - sampleAt > 700) {
      $('rate').textContent = ((completed * 1000) / (now - sampleAt)).toFixed(1);
      sampleAt = now;
      completed = 0;
    }
    $('bytes').textContent = `${(frame.bytes.length / 1024).toFixed(0)} KiB`;
    $('generation').textContent = `${frame.generationMs.toFixed(1)} ms`;
    $('colors').textContent = `${frame.sgrChanges.toLocaleString()} SGR sequences`;
    $('download').setAttribute('aria-disabled', 'false');
    status(
      `${terminal.cols} × ${terminal.rows} · ${frame.particles.toLocaleString()} particles · ${running ? 'running' : 'paused'}`,
    );
  } finally {
    busy = false;
  }
}
function schedule() {
  cancelAnimationFrame(raf);
  if (!running || !lab.ready || disposed || document.hidden) return;
  raf = requestAnimationFrame(async (now) => {
    if (busy) {
      schedule();
      return;
    }
    advance(now);
    try {
      await present(animation);
    } catch (e) {
      fail(e);
      return;
    }
    schedule();
  });
}
function pause(value) {
  advance(performance.now());
  running = !value;
  $('pause').textContent = running ? 'Pause' : 'Resume';
  schedule();
}
async function drain() {
  while (busy) await new Promise((r) => setTimeout(r, 10));
}
async function mount() {
  const wasRunning = running;
  pause(true);
  lab.ready = false;
  ++version;
  $('resolution').disabled = true;
  for (const key of ['pause', 'restart', 'pulse']) $(key).disabled = true;
  await drain();
  try {
    await terminal?.dispose();
    terminal = undefined;
    const [cols, rows] = $('resolution').value.split('x').map(Number);
    const rect = $('viewport').getBoundingClientRect();
    const size = Math.max(4, Math.min(rect.width / (cols * 0.6), rect.height / (rows * 1.2)));
    terminal = await Wraith.mount($('terminal'), {
      cols,
      rows,
      fit: false,
      fontSize: size,
      lineHeight: 1.2,
      scrollback: 0,
      theme: { background: '#0c0806', foreground: '#f5ece3', cursor: '#0c0806' },
    });
    terminal.onStats((s) => {
      $('render').textContent = `${s.renderP50Ms.toFixed(2)} ms`;
      lab.adapter = s.adapter;
    });
    terminal.onError(fail);
    await terminal.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
    animation = reduced && !film ? 5 : 0;
    delete input.x;
    delete input.y;
    delete input.pulse;
    lab.error = null;
    lab.ready = true;
    await present(animation);
    for (const key of ['pause', 'restart', 'pulse']) $(key).disabled = false;
    lastClock = performance.now();
    sampleAt = lastClock;
    completed = 0;
    pause(film || reduced || !wasRunning);
  } catch (e) {
    fail(e);
  } finally {
    $('resolution').disabled = false;
  }
}
$('pause').onclick = () => pause(running);
const replay = async () => {
  pause(true);
  await drain();
  animation = 0;
  delete input.pulse;
  await present(0);
  pause(false);
};
$('restart').onclick = () => {
  void replay().catch(fail);
};
$('pulse').onclick = () => {
  input.pulse = animation;
  if (!running) {
    void drain()
      .then(() => present(animation))
      .catch(fail);
  }
};
$('speed').onchange = () => {
  lastClock = performance.now();
};
$('resolution').onchange = () => {
  void mount();
};
$('fullscreen').onclick = () => {
  const w = document.querySelector('.reactor-window');
  void (document.fullscreenElement ? document.exitFullscreen() : w.requestFullscreen()).catch(fail);
};
$('viewport').onpointermove = (e) => {
  const r = $('viewport').getBoundingClientRect();
  input.x = Math.max(0.28, Math.min(0.78, (e.clientX - r.left) / r.width));
  input.y = Math.max(0.18, Math.min(0.7, (e.clientY - r.top) / r.height));
};
$('viewport').onpointerleave = () => {
  delete input.x;
  delete input.y;
};
$('viewport').onpointerdown = () => {
  input.pulse = animation;
};
$('download').onclick = (e) => {
  e.preventDefault();
  if (!current) return;
  const url = URL.createObjectURL(new Blob([current.bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'wraith-ghost-reactor.ansi';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener('visibilitychange', () => {
  lastClock = performance.now();
  schedule();
});
window.addEventListener('pagehide', () => {
  disposed = true;
  running = false;
  cancelAnimationFrame(raf);
  worker.terminate();
  clearTimeout(pending?.timer);
  pending?.reject(new Error('Reactor closed'));
  pending = undefined;
  void terminal?.dispose();
});
lab.pause = pause;
lab.frame = async (t) => {
  pause(true);
  await drain();
  animation = t;
  await present(t);
};
lab.pulse = () => {
  input.pulse = animation;
};
lab.getText = () => terminal?.getText();
lab.getFrame = () => current?.bytes;
running = !film && !reduced;
void mount();
