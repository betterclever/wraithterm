import { Terminal as WraithTerminal } from '../packages/wraith/src/xterm.ts';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import '../packages/wraith/css/xterm.css';
import { PIPE_PRESETS, PIPE_SEED } from './pipes-scene.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
for (const id of ['renderer', 'preset', 'source', 'traffic', 'colors', 'speed']) {
  if ([...$(id).options].some((option) => option.value === params.get(id)))
    $(id).value = params.get(id);
}
$('seed').value = String(Number(params.get('seed') ?? PIPE_SEED) >>> 0);
if (params.has('pipes')) $('pipes').value = params.get('pipes');
const font = new FontFace(
  'PipesMono',
  `url(${new URL('./fonts/JetBrainsMono-Regular.ttf', import.meta.url)})`,
);
let terminal,
  worker,
  frames = [],
  current,
  stats,
  sceneStats,
  running = false,
  ready = false,
  generation = 0,
  activeMode = 'growth',
  activeType = 'wraith',
  activeSeed = PIPE_SEED;
let lastSample = 0,
  completed = 0,
  serial = 0,
  bankBytes = 0,
  inFlight = false,
  workerPending = false;
let requestId = 0,
  cancelWrite,
  lastFrameTime = 0,
  animationTime = 0,
  clockAt = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const setStatus = (value) => {
  $('status').textContent = value;
};
function fit() {
  const screen = $('terminal').querySelector('.xterm-screen');
  if (!screen) return;
  const width = screen.offsetWidth,
    height = screen.offsetHeight;
  if (!width || !height) return;
  const scale = Math.min(1, $('viewport').clientWidth / width);
  $('terminal').style.transform = `scale(${scale})`;
  $('terminal').style.left = `${Math.max(0, ($('viewport').clientWidth - width * scale) / 2)}px`;
  $('viewport').style.height = `${height * scale}px`;
}
new ResizeObserver(fit).observe($('viewport'));
function pause(value) {
  const now = performance.now();
  if (running && !document.hidden) animationTime += (now - clockAt) / 1000;
  clockAt = now;
  running = !value;
  $('pause').textContent = running ? 'Ⅱ' : '▶';
  $('pause').setAttribute('aria-label', running ? 'Pause animation' : 'Resume animation');
  lastSample = performance.now();
  completed = 0;
  if (value) {
    $('rate').textContent = 'Paused';
    setStatus('PAUSED · download this exact ANSI frame below');
  } else if (ready) {
    setStatus('RUNNING · one frame in flight · no write backlog');
    schedule();
  }
}
function stop() {
  ready = false;
  running = false;
  cancelAnimationFrame(requestId);
  cancelWrite?.();
  worker?.terminate();
  worker = undefined;
  terminal?.dispose();
  terminal = undefined;
  frames = [];
  current = undefined;
  inFlight = false;
  workerPending = false;
}
function fail(error) {
  ++generation;
  stop();
  setStatus(String(error));
  $('rate').textContent = 'Stopped';
  $('pause').disabled = true;
  $('download').disabled = true;
  window.pipesLab.error = String(error);
}
function writeFrame(bytes) {
  const target = terminal;
  return new Promise((resolve, reject) => {
    let parsed = false;
    const done = (error) => {
      clearTimeout(timeout);
      listener.dispose();
      cancelWrite = undefined;
      if (error) reject(error);
      else resolve();
    };
    const listener = target.onRender(() => {
      if (parsed) done();
    });
    const timeout = setTimeout(
      () => done(new Error('Terminal render timed out after 10 seconds')),
      10000,
    );
    cancelWrite = () => done(new DOMException('Scene replaced', 'AbortError'));
    try {
      target.write(bytes, () => {
        parsed = true;
      });
    } catch (error) {
      done(error);
    }
  });
}
async function present(frame, version) {
  if (inFlight || version !== generation) return;
  inFlight = true;
  current = frame;
  try {
    const start = performance.now();
    await writeFrame(frame.bytes);
    if (version !== generation) return;
    completed++;
    stats = {
      generationMs: frame.generationMs,
      bytes: frame.bytes.length,
      sgrChanges: frame.sgrChanges,
      lastWriteToRenderMs: performance.now() - start,
      bankBytes,
      completed: ++serial,
      growth: frame.growth,
    };
    $('bytes').textContent = `${(frame.bytes.length / 1024).toFixed(0)} KiB`;
    $('sgr').textContent = `${frame.sgrChanges.toLocaleString()} SGR sequences / frame`;
    $('generation').textContent = `${frame.generationMs.toFixed(1)} ms`;
    $('download').disabled = false;
    if (frame.scene) {
      sceneStats = frame.scene;
      $('triangles').textContent = frame.scene.triangles.toLocaleString();
      $('geometry').textContent =
        `${frame.scene.pipes} growing ${frame.scene.pipes === 1 ? 'pipe' : 'pipes'} · cycle ${frame.growth.cycle + 1}`;
      if (running)
        setStatus(
          `XP · ${frame.growth.stage.toUpperCase()} · cycle ${frame.growth.cycle + 1} · ${Math.round(frame.growth.progress * 100)}%`,
        );
    }
    if (running && performance.now() - lastSample >= 800) {
      $('rate').textContent = ((completed * 1000) / (performance.now() - lastSample)).toFixed(1);
      lastSample = performance.now();
      completed = 0;
    }
  } catch (error) {
    if (error.name !== 'AbortError' && version === generation) fail(error);
  } finally {
    if (version === generation) {
      inFlight = false;
      // onRender already provides browser pacing. Prepare the next write now,
      // rather than adding a second animation-frame wait and halving cadence.
      schedule(true);
    }
  }
}
function schedule(immediate = false) {
  cancelAnimationFrame(requestId);
  if (!running || !ready || inFlight || document.hidden) return;
  if (immediate === true) tick(performance.now());
  else requestId = requestAnimationFrame(tick);
}
function tick(time) {
  if (!running || !ready || inFlight || document.hidden) return;
  if (activeMode === 'replay') {
    const step = serial % (frames.length * 2 - 2);
    void present(frames[step < frames.length ? step : frames.length * 2 - 2 - step], generation);
  } else if (!workerPending) {
    workerPending = true;
    animationTime += Math.max(0, time - clockAt) / 1000;
    clockAt = time;
    lastFrameTime = animationTime;
    worker.postMessage({ kind: 'frame', time: lastFrameTime });
  }
}
async function start() {
  const version = ++generation;
  stop();
  window.pipesLab.error = undefined;
  $('pause').disabled = true;
  $('download').disabled = true;
  $('terminal').replaceChildren();
  $('rate').textContent = '—';
  serial = 0;
  completed = 0;
  bankBytes = 0;
  animationTime = 0;
  const preset = PIPE_PRESETS[$('preset').value];
  const seed = Number($('seed').value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('Seed must be 0..4294967295');
  const type = $('renderer').value,
    mode = $('source').value;
  const pipeCount = Number($('pipes').value),
    speed = Number($('speed').value);
  if (!Number.isInteger(pipeCount) || pipeCount < 1 || pipeCount > 80)
    throw new Error('Growing pipe count must be 1..80');
  activeType = type;
  activeMode = mode;
  activeSeed = seed;
  const options = {
    ...preset,
    ...(mode === 'growth' ? { pipes: pipeCount, speed } : {}),
    seed,
    colors: $('colors').value,
    traffic: $('traffic').value,
  };
  for (const id of ['renderer', 'preset', 'source', 'traffic', 'colors', 'seed', 'pipes', 'speed'])
    params.set(id, $(id).value);
  history.replaceState(null, '', `${location.pathname}?${params}`);
  setStatus('INITIALIZING · terminal + software geometry worker');
  document.fonts.add(await font.load());
  if (version !== generation) return;
  const Terminal = type === 'wraith' ? WraithTerminal : XtermTerminal;
  const target = new Terminal({
    cols: preset.cols,
    rows: preset.rows,
    fontFamily: 'PipesMono',
    fontSize: 15,
    lineHeight: 1,
    scrollback: 0,
    cursorBlink: false,
    minimumContrastRatio: 1,
    allowProposedApi: true,
    theme: { background: '#0c0806', foreground: '#f5ece3' },
  });
  terminal = target;
  target.open($('terminal'));
  if (type === 'webgl') {
    const addon = new WebglAddon();
    target.loadAddon(addon);
    addon.onContextLoss(() => {
      if (version === generation) fail(new Error('WebGL context lost'));
    });
  }
  const gpuReady = type === 'wraith' ? await target.webgpuReady : true;
  if (version !== generation) return;
  if (!gpuReady) throw new Error(`WebGPU unavailable: ${target.rendererFallbackReason}`);
  $('window-renderer').textContent = `/ ${$('renderer').selectedOptions[0].textContent}`;
  $('grid').textContent = `${preset.cols} × ${preset.rows} CELLS`;
  $('mode-title').textContent = mode === 'growth' ? '/ XP.' : '/ 95.';
  $('cli').textContent =
    mode === 'growth'
      ? `npm run pipes -- --mode growth --pipes ${pipeCount}`
      : `npm run pipes -- --preset ${$('preset').value}`;
  $('generation-note').textContent =
    mode === 'replay'
      ? 'Prebaked in worker; excluded from playback'
      : 'Live in worker; included in animation cadence';
  fit();
  worker = new Worker(new URL('./pipes-worker.js', import.meta.url), { type: 'module' });
  worker.onerror = (event) => {
    if (version === generation) fail(event.message);
  };
  worker.onmessage = ({ data }) => {
    if (version !== generation) return;
    if (data.kind === 'error') {
      fail(data.message);
      return;
    }
    if (data.kind === 'scene') {
      sceneStats = data.stats;
      $('triangles').textContent = data.stats.triangles.toLocaleString();
      $('geometry').textContent =
        `${data.stats.pipes} pipes · ${data.stats.elbows} elbows · ${data.stats.segments} segments`;
    } else if (data.kind === 'frame') {
      if (mode === 'replay') {
        frames[data.index] = data;
        bankBytes += data.bytes.length;
        setStatus(
          `BAKING · ${data.index + 1}/${data.total} frames · ${(bankBytes / 1048576).toFixed(1)} MiB bounded replay bank`,
        );
        if (data.index === 0) void present(data, version);
      } else {
        workerPending = false;
        if (running || serial === 0) void present(data, version);
      }
    } else if (data.kind === 'ready') {
      ready = true;
      clockAt = performance.now();
      lastSample = clockAt;
      $('pause').disabled = false;
      pause(reducedMotion || params.get('paused') === '1');
      if (!running && mode !== 'replay') {
        workerPending = true;
        worker.postMessage({ kind: 'frame', time: 0 });
      }
    }
  };
  worker.postMessage({ kind: 'init', mode, options });
}
$('apply').onclick = () => {
  void start().catch(fail);
};
$('pause').onclick = () => pause(running);
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector('.monitor').requestFullscreen();
    fit();
  } catch (error) {
    setStatus(`Fullscreen unavailable: ${error.message}`);
  }
};
$('download').onclick = () => {
  if (!current) return;
  const blob = new Blob([current.bytes, '\x1b[0m\x1b[?7h\x1b[?25h'], {
    type: 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = `wraith-pipes-${activeSeed}.ansi`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener('visibilitychange', () => {
  clockAt = performance.now();
  schedule();
});
window.addEventListener('pagehide', () => {
  ++generation;
  stop();
});
// Read-only observability for browser verification; playback always uses public write/onRender.
window.pipesLab = {
  get state() {
    return {
      ready,
      running,
      inFlight,
      workerPending,
      frames: frames.length,
      bankBytes,
      stats,
      scene: sceneStats,
      renderer: terminal instanceof WraithTerminal ? terminal.renderer : activeType,
      source: activeMode,
      cols: terminal?.cols,
      rows: terminal?.rows,
      terminalLines: terminal?.buffer.active.length,
    };
  },
  error: undefined,
};
void start().catch(fail);
