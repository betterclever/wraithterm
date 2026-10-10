import { Terminal as WraithTerminal } from '../packages/wraith/src/xterm.ts';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import init, { Engine, Headless } from '../packages/wraith/wasm/wraith_engine.js';
import '../packages/wraith/css/xterm.css';
import { showcase } from './showcase.js';
const encoder = new TextEncoder();
const scene = document.querySelector('#scene');
const status = document.querySelector('#status');
const percentiles = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (f) => sorted[Math.max(0, Math.ceil(f * sorted.length) - 1)] ?? 0;
  return {
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
};
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
function invariant(value, message) {
  if (!value) throw new Error(message);
}
const rgb = (value) => [value >>> 16, (value >>> 8) & 255, value & 255].join(';');
const foregrounds = [
  0xa8c7fa, 0x8ee0b5, 0xefc87a, 0xc9a7ed, 0xef96b5, 0x90d9eb, 0xdfebf5, 0x83b99d, 0xd9a685,
  0x8a9ed1, 0xc8d99c, 0xbc8cd3, 0xf1bd95, 0x84c5b1, 0xadcedd, 0xd3bfa4,
];
const backgrounds = [0x101824, 0x142236, 0x1c2638, 0x102c2b];
const chars = [
  ...'0123456789abcdefABCDEF{}[]();:/=>+-_!@#$%^&*~',
  ...'αβγδεζηθλμνξπρστυφψω',
  ...'─│┌┐└┘├┤┬┴┼░▒▓█▁▂▃▄▅▆▇',
  'é',
  'ä',
];
function workload(cols, rows, variant, kind) {
  if (kind === 'showcase') return showcase(cols, rows, variant, encoder);
  if (kind === 'append') {
    // Log streaming: eight styled lines per update scroll the viewport.
    let output = '';
    for (let k = 0; k < 8; k++) {
      const n = variant * 8 + k;
      const level = ['INFO', 'WARN', 'DEBUG', 'ERROR'][n % 4];
      output +=
        `\x1b[38;2;${rgb(foregrounds[n % foregrounds.length])}m12:00:${String(n % 60).padStart(2, '0')}.${String(n * 37).padStart(4, '0')}\x1b[0m ` +
        `\x1b[1;3${(n % 6) + 1}m${level.padEnd(5)}\x1b[0m ` +
        `worker-${n % 13} ${'processed batch ' + n + ' αβγ ─│ '}`
          .repeat(1 + (n % 5))
          .slice(0, cols - 30) +
        '\r\n';
    }
    return { bytes: encoder.encode(output), sgrChanges: 24, variant };
  }
  let output = '\x1b[?25l' + (kind === 'scroll' ? `\x1b[${rows};1H\r\n` : '');
  let sgrChanges = 0;
  for (let y = 0; y < rows; y++) {
    output += `\x1b[${y + 1};1H`;
    for (let x = 0; x < cols; x += 4) {
      const block = Math.floor(x / 4);
      const fg =
        kind === 'churn'
          ? (block * 1301 + y * 7919 + variant * 28091) & 0xffffff
          : foregrounds[(block + y + variant) % foregrounds.length];
      const bg = backgrounds[(Math.floor(block / 3) + y + variant) % backgrounds.length];
      const style = [0, 1, 3, '4:3', 9][(block + y + variant) % 5];
      output += `\x1b[0;${style};38;2;${rgb(fg)};48;2;${rgb(bg)}m`;
      sgrChanges++;
      for (let j = 0; j < 4 && x + j < cols; j++) {
        output += chars[(x + j + y * 7 + variant * 13) % chars.length];
      }
    }
  }
  output += '\x1b[0m\x1b[1;1H\x1b[1;38;2;223;235;245;48;2;16;24;36m';
  output += ` WRAITH STRESS / ${cols}x${rows} / ${kind} / FRAME ${variant} `.padEnd(cols, '─');
  output += '\x1b[0m\x1b[H';
  return { bytes: encoder.encode(output), sgrChanges, variant };
}
let wasmReady;
let fontBytes;
async function font() {
  if (!fontBytes) {
    const response = await fetch(new URL('./fonts/JetBrainsMono-Regular.ttf', import.meta.url));
    invariant(response.ok, 'Font download failed');
    fontBytes = new Uint8Array(await response.arrayBuffer());
    const face = new FontFace('WraithBench', fontBytes.buffer);
    document.fonts.add(await face.load());
    await document.fonts.ready;
  }
  return fontBytes;
}
function stopScheduler(terminal, renderer) {
  const service = terminal._core._renderService;
  service._renderDebouncer.dispose();
  service._observerDisposable.clear();
  const refresh = service.refreshRows;
  service.refreshRows = () => {};
  if (renderer.timer) clearInterval(renderer.timer);
  return () => {
    service.refreshRows = refresh;
  };
}
async function glFence(gl) {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  invariant(sync, 'WebGL fence failed');
  gl.flush();
  try {
    const started = performance.now();
    for (;;) {
      const state = gl.clientWaitSync(sync, 0, 0);
      if (state === gl.ALREADY_SIGNALED || state === gl.CONDITION_SATISFIED) return;
      invariant(
        state !== gl.WAIT_FAILED && performance.now() - started < 10000,
        'WebGL fence wait failed',
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    gl.deleteSync(sync);
  }
}
function visibleText(terminal) {
  const b = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, y) =>
    b.getLine(b.viewportY + y).translateToString(false),
  ).join('\n');
}
async function mount(type, config) {
  const bytes = await font();
  scene.replaceChildren();
  const host = document.createElement('div');
  scene.append(host);
  host.style.width = `${config.cols * 9}px`;
  host.style.height = `${config.rows * 20}px`;
  const options = {
    cols: config.cols,
    rows: config.rows,
    fontSize: 15,
    fontFamily: 'WraithBench',
    lineHeight: 1,
    scrollback: 2000,
    cursorBlink: false,
    allowProposedApi: true,
    minimumContrastRatio: 1,
    theme: { background: '#101824', foreground: '#dfebf5' },
  };
  if (type === 'ghostty') {
    // Derive the native cell height from exactly the same browser font metrics.
    const probe = new XtermTerminal(options);
    probe.open(host);
    await nextFrame();
    const dimensions = structuredClone(probe._core._renderService.dimensions);
    probe.dispose();
    const canvas = document.createElement('canvas');
    host.append(canvas);
    Object.assign(canvas.style, {
      width: `${dimensions.css.canvas.width}px`,
      height: `${dimensions.css.canvas.height}px`,
    });
    wasmReady ??= init();
    await wasmReady;
    const engine = await Engine.create(
      canvas.transferControlToOffscreen(),
      bytes,
      config.cols,
      config.rows,
      15 * devicePixelRatio,
      dimensions.device.cell.height / (15 * devicePixelRatio),
      2000,
    );
    invariant(
      engine.cell_width === dimensions.device.cell.width &&
        engine.cell_height === dimensions.device.cell.height,
      'Native canvas cell geometry differs',
    );
    engine.theme(0xf5ebdf, 0x241810, 0xf5ebdf);
    return {
      type,
      host,
      canvas,
      engine,
      dimensions,
      parse: (data) => engine.write(data),
      draw: () => engine.render(performance.now(), true),
      finish: () => engine.fence(),
      submitted: () => Number(engine.metrics()[0]),
      text: () => engine.text(false),
      dispose: () => engine.free(),
      restore: () => {},
    };
  }
  const terminal = type === 'wraith' ? new WraithTerminal(options) : new XtermTerminal(options);
  terminal.open(host);
  let addon;
  if (type === 'webgl') {
    addon = new WebglAddon();
    terminal.loadAddon(addon);
  }
  if (type === 'wraith')
    invariant(await terminal.webgpuReady, 'Wraith WebGPU initialization failed');
  await nextFrame();
  await nextFrame();
  const renderer = terminal._core._renderService._renderer.value;
  const dimensions = structuredClone(renderer.dimensions);
  const restore = stopScheduler(terminal, renderer);
  const parse = (data) => {
    const result = terminal._core._inputHandler.parse(data);
    invariant(!result?.then, 'Unexpected async parser handler');
  };
  const finish =
    type === 'wraith'
      ? () => renderer.gpu.fence()
      : type === 'webgl'
        ? () => glFence(renderer._gl)
        : async () => {};
  return {
    type,
    host,
    terminal,
    renderer,
    dimensions,
    restore,
    parse,
    finish,
    submitted: type === 'wraith' ? () => Number(renderer.gpu.frames) : undefined,
    draw: () => {
      renderer.renderRows(0, config.rows - 1);
      void host.offsetHeight;
    },
    text: () => visibleText(terminal),
    dispose: () => terminal.dispose(),
    assert: () => {
      if (type === 'wraith')
        invariant(
          terminal.renderer === 'webgpu',
          'Wraith fell back: ' + terminal.rendererFallbackReason,
        );
      if (type === 'webgl') invariant(!renderer._gl.isContextLost(), 'WebGL context lost');
    },
  };
}
let active;
async function setup(config) {
  invariant(['dom', 'webgl', 'wraith', 'ghostty'].includes(config.type), 'Unknown renderer');
  invariant(
    ['complex', 'churn', 'scroll', 'append', 'showcase'].includes(config.workload),
    'Unknown workload',
  );
  active?.dispose();
  active = await mount(config.type, config);
  const inputs = Array.from({ length: 8 }, (_, i) =>
    workload(config.cols, config.rows, i, config.workload),
  );
  active.inputs = inputs;
  active.parse(inputs[0].bytes);
  active.draw();
  await active.finish();
  // Large WebGL atlas growth can remap glyphs during the first model update.
  // Let the official renderer rebuild its model before validating pixels.
  if (config.type === 'webgl') {
    active.draw();
    await active.finish();
  }
  active.assert?.();
  await nextFrame();
  await nextFrame();
  status.textContent = `${config.type} / ${config.workload} / ${config.cols}×${config.rows} / DPR ${devicePixelRatio}`;
  return {
    dimensions: active.dimensions,
    text: active.text(),
    bytesPerFrame: inputs[0].bytes.length,
    sgrChangesPerFrame: inputs[0].sgrChanges,
    glyphAlphabet: chars.length,
  };
}
function cacheInfo(a) {
  if (a.type === 'wraith')
    return {
      glyphVariants: [...a.renderer.atlas.cache.values()].reduce(
        (n, v) => n + v.filter(Boolean).length,
        0,
      ),
    };
  if (a.type === 'webgl')
    return {
      atlasPages: a.renderer._charAtlas.pages.length,
      glyphs: a.renderer._charAtlas.pages.reduce((n, p) => n + p.glyphs.length, 0),
    };
  if (a.type === 'ghostty') {
    const m = Array.from(a.engine.metrics());
    return {
      glyphVariants: m[5],
      atlasHits: m[6],
      atlasMisses: m[7],
      atlasResets: m[8],
      reusedRows: m[9],
    };
  }
  return { spans: a.host.querySelectorAll('.xterm-rows span').length };
}
async function run(config) {
  if (!active || active.type !== config.type) await setup(config);
  const a = active,
    frames = config.frames ?? 128,
    warmup = 32;
  // Warm every variant, including all intrinsic color/glyph cache misses.
  for (let i = 0; i < warmup; i++) {
    a.parse(a.inputs[i % 8].bytes);
    a.draw();
    if ((i + 1) % 32 === 0) await a.finish();
  }
  const cacheBefore = cacheInfo(a);
  const parseTimes = [];
  for (let i = 0; i < 64; i++) {
    const t = performance.now();
    a.parse(a.inputs[i % 8].bytes);
    parseTimes.push(performance.now() - t);
  }
  let snapshots;
  if (a.terminal) {
    snapshots = [];
    for (const input of a.inputs) {
      a.parse(input.bytes);
      const b = a.terminal._core.buffer;
      snapshots.push(
        Array.from({ length: config.rows }, (_, y) => b.lines.get(b.ybase + y).clone()),
      );
    }
  }
  const renderTimes = [];
  for (let i = 0; i < frames; i++) {
    if (a.terminal) {
      const b = a.terminal._core.buffer;
      for (let y = 0; y < config.rows; y++) b.lines.set(b.ybase + y, snapshots[i % 8][y]);
    } else a.parse(a.inputs[i % 8].bytes);
    const t = performance.now();
    a.draw();
    renderTimes.push(performance.now() - t);
    if ((i + 1) % 32 === 0) await a.finish();
  }
  await a.finish();
  const pipelineTimes = [];
  const submittedBefore = a.submitted?.();
  const pipelineStart = performance.now();
  for (let i = 0; i < frames; i++) {
    const t = performance.now();
    a.parse(a.inputs[i % 8].bytes);
    a.draw();
    pipelineTimes.push(performance.now() - t);
    if ((i + 1) % 32 === 0) await a.finish();
  }
  await a.finish();
  const pipelineElapsedMs = performance.now() - pipelineStart;
  const submittedFrames =
    submittedBefore === undefined ? undefined : a.submitted() - submittedBefore;
  if (submittedFrames !== undefined)
    invariant(submittedFrames === frames, 'Pipeline did not submit every counted frame');
  a.assert?.();
  const result = {
    type: config.type,
    workload: config.workload,
    cols: config.cols,
    rows: config.rows,
    dpr: devicePixelRatio,
    frames,
    submittedFrames,
    bytesPerFrame: a.inputs[0].bytes.length,
    sgrChangesPerFrame: a.inputs[0].sgrChanges,
    dimensions: a.dimensions,
    parseMs: percentiles(parseTimes),
    renderAndLayoutMs: percentiles(renderTimes),
    pipelineCpuMs: percentiles(pipelineTimes),
    pipelineElapsedMs,
    pipelineUpdatesPerSecond: (frames * 1000) / pipelineElapsedMs,
    gpuFenced: config.type !== 'dom',
    inputMiBPerSecond: (a.inputs[0].bytes.length * frames) / 1048576 / (pipelineElapsedMs / 1000),
    cacheBefore,
    cacheAfter: cacheInfo(a),
  };
  if (a.terminal) {
    a.restore();
    await nextFrame();
    const original = a.renderer.renderRows.bind(a.renderer),
      durations = [],
      intervals = [];
    a.renderer.renderRows = (...args) => {
      const t = performance.now();
      original(...args);
      void a.host.offsetHeight;
      durations.push(performance.now() - t);
    };
    let previous;
    const pacedStart = performance.now();
    for (let i = 0; i < 48; i++) {
      const started = performance.now();
      await new Promise((resolve) => {
        const disposable = a.terminal.onRender(() => {
          disposable.dispose();
          const now = performance.now();
          if (previous) intervals.push(now - previous);
          previous = now;
          resolve();
        });
        a.terminal.write(a.inputs[i % 8].bytes);
      });
      invariant(performance.now() - started < 10000, 'Paced write stalled');
    }
    const elapsedMs = performance.now() - pacedStart;
    result.publicApiPacing = {
      frames: 48,
      elapsedMs,
      renderCallbacksPerSecond: (48 * 1000) / elapsedMs,
      frameIntervalMs: percentiles(intervals),
      rendererCpuMs: percentiles(durations),
      intervalsOver8_33Ms: intervals.filter((t) => t > 8.3334).length,
      intervalsOver16_67Ms: intervals.filter((t) => t > 16.667).length,
    };
    a.renderer.renderRows = original;
    stopScheduler(a.terminal, a.renderer);
    a.assert?.();
  }
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
  return result;
}
async function idleCadence() {
  const times = [];
  for (let i = 0; i < 32; i++) times.push(await nextFrame());
  return percentiles(times.slice(1).map((t, i) => t - times[i]));
}
async function profile(iterations = 128) {
  invariant(active, 'Set up a renderer before profiling');
  const a = active;
  for (let i = 0; i < iterations; i++) {
    a.parse(a.inputs[i % 8].bytes);
    a.draw();
    if ((i + 1) % 32 === 0) await a.finish();
  }
  await a.finish();
  a.assert?.();
  return cacheInfo(a);
}
async function utilization({ durationMs = 10000, targetUpdatesPerSecond = 30 } = {}) {
  invariant(active, 'Set up a renderer before measuring utilization');
  invariant(durationMs >= 1000 && durationMs <= 60000, 'Invalid utilization duration');
  invariant(targetUpdatesPerSecond >= 0, 'Invalid update rate');
  const a = active;
  const started = performance.now();
  const submittedBefore = a.submitted?.();
  const intervals = [];
  let previous,
    frames = 0,
    droppedDeadlines = 0;
  while (performance.now() - started < durationMs) {
    const now = performance.now();
    if (previous !== undefined) intervals.push(now - previous);
    previous = now;
    a.parse(a.inputs[frames % 8].bytes);
    a.draw();
    frames++;
    if (frames % 32 === 0) await a.finish();
    if (targetUpdatesPerSecond) {
      const remaining = started + (frames * 1000) / targetUpdatesPerSecond - performance.now();
      if (remaining < 0) droppedDeadlines++;
      // Yield even when overloaded so the browser can paint and counters can be sampled.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining)));
    } else if (frames % 8 === 0) {
      // The raw throughput mode coalesces DOM paints, as in the comparison benchmark.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  await a.finish();
  a.assert?.();
  const elapsedMs = performance.now() - started;
  const submittedFrames =
    submittedBefore === undefined ? undefined : a.submitted() - submittedBefore;
  if (submittedFrames !== undefined)
    invariant(submittedFrames === frames, 'Utilization loop did not submit every counted frame');
  return {
    type: a.type,
    durationMs,
    elapsedMs,
    frames,
    submittedFrames,
    targetUpdatesPerSecond,
    updatesPerSecond: (frames * 1000) / elapsedMs,
    droppedDeadlines,
    intervalMs: percentiles(intervals),
    cache: cacheInfo(a),
    gpuFenced: a.type !== 'dom',
  };
}
async function adapterInfo() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const i = adapter?.info;
  const gl = active?.renderer?._gl;
  const debug = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    webgpu: i
      ? {
          vendor: i.vendor,
          architecture: i.architecture,
          device: i.device,
          description: i.description,
        }
      : {},
    webgl: debug
      ? {
          vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
          renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
          attributes: gl.getContextAttributes(),
        }
      : {},
  };
}
window.comparison = {
  setup,
  run,
  profile,
  utilization,
  /** Render one fixture on either GPU path for pixel differentials. */
  async fixture({ data, options = {}, selection, focus = true }) {
    invariant(['wraith', 'ghostty'].includes(active?.type), 'Fixture requires a GPU renderer');
    const a = active;
    if (a.type === 'ghostty') {
      a.engine.write(encoder.encode('\x1bc' + data));
      if (selection) a.engine.select(...selection);
    } else {
      a.terminal.reset();
      a.terminal.options = options;
      if (focus) a.terminal.focus();
      else a.terminal.blur();
      a.parse(encoder.encode(data));
      if (selection) a.terminal.select(selection[0], selection[1], selection[2]);
      else a.terminal.clearSelection();
      await nextFrame();
    }
    a.draw();
    await a.finish();
    a.assert?.();
    await nextFrame();
    await nextFrame();
    return a.text();
  },
  async packedFixture({
    data,
    options = {},
    selection,
    partial = [0, 7],
    hideWords = false,
    rowLayout = 'normal',
    packingDiagnostics = false,
  }) {
    invariant(active?.type === 'wraith', 'Packed fixture requires Wraith');
    const a = active;
    a.terminal.reset();
    a.terminal.options = options;
    a.parse(encoder.encode(data));
    if (selection) a.terminal.select(...selection);
    else a.terminal.clearSelection();
    // Selection redraw events are delivered on an animation frame, independent
    // of the GPU fence. Consume them before comparing renderer snapshots.
    await nextFrame();
    a.draw();
    await a.finish();
    a.assert();
    const buffer = a.terminal.buffer.active;
    const getLine = buffer.getLine;
    let getterCalls = 0;
    if (hideWords || rowLayout !== 'normal' || packingDiagnostics)
      buffer.getLine = function (index) {
        const line = getLine.call(this, index);
        if (!line) return line;
        return new Proxy(line, {
          get(target, key) {
            if (key === '_line') {
              if (hideWords || rowLayout === 'absent') return undefined;
              if (rowLayout !== 'normal')
                return {
                  length: line.length,
                  _data:
                    rowLayout === 'short' ? new Uint32Array(1) : new Uint8Array(line.length * 3),
                };
            }
            if (key === 'getCell')
              return (x, cell) => {
                getterCalls++;
                const data = target.getCell(x, cell);
                if (!data || !hideWords) return data;
                return new Proxy(data, {
                  get(cell, property) {
                    if (['fg', 'bg', 'content'].includes(property)) return undefined;
                    const value = Reflect.get(cell, property);
                    return typeof value === 'function' ? value.bind(cell) : value;
                  },
                });
              };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
    try {
      // Packing updates staging in place; force a repack and read the rows.
      const staged = (start, end) => {
        a.renderer.rowCached.fill(0);
        a.renderer.pack(start, end);
        const words = a.terminal.cols * 5;
        return Array.from(a.renderer.staging.subarray(start * words, (end + 1) * words));
      };
      const full = staged(0, a.terminal.rows - 1);
      const rows = staged(...partial);
      return {
        full,
        rows,
        text: hideWords ? undefined : a.text(),
        renderer: a.terminal.renderer,
        ...(packingDiagnostics ? { getterCalls } : {}),
      };
    } finally {
      buffer.getLine = getLine;
    }
  },
  adapterInfo,
  text: () => active.text(),
  workload,
  idleCadence,
  dispose: () => {
    active?.dispose();
    active = undefined;
  },
};
const params = new URLSearchParams(location.search);
const config = {
  type: params.get('type') ?? 'wraith',
  workload: params.get('workload') ?? 'complex',
  cols: 240,
  rows: 80,
  frames: 128,
};
const controls = [...document.querySelectorAll('button,select')];
const busy = (value) =>
  controls.forEach((element) => {
    element.disabled = value;
  });
document.querySelector('#type').value = config.type;
document.querySelector('#workload').value = config.workload;
for (const id of ['type', 'workload'])
  document.querySelector('#' + id).addEventListener('change', async () => {
    config.type = document.querySelector('#type').value;
    config.workload = document.querySelector('#workload').value;
    busy(true);
    try {
      window.comparison.ready = setup(config);
      await window.comparison.ready;
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busy(false);
    }
  });
document.querySelector('#run').addEventListener('click', async () => {
  busy(true);
  try {
    await run(config);
  } catch (e) {
    status.textContent = String(e);
  } finally {
    busy(false);
  }
});
busy(true);
window.comparison.ready = setup(config)
  .catch((error) => {
    window.failure = String(error);
    status.textContent = String(error);
  })
  .finally(() => busy(false));
