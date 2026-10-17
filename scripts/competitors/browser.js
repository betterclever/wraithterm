import {
  mount,
  workload,
  font,
  percentiles,
} from '../../.cache/competitor-packages/wraith-adapter.js';
import {
  init as initGhostty,
  Terminal as GhosttyTerminal,
} from '../../.cache/competitor-packages/node_modules/ghostty-web/dist/ghostty-web.js';
import {
  createResttyRuntime,
  createResttyRuntimeSession,
} from '../../.cache/competitor-packages/node_modules/restty/dist/internal/runtime.js';
import { parseGhosttyTheme } from '../../.cache/competitor-packages/node_modules/restty/dist/restty.js';

const config = { cols: 240, rows: 80 };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancel = window.cancelAnimationFrame.bind(window);
const nativeFrame = () => new Promise(nativeRaf);
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
const normalized = (text) =>
  text
    .split('\n')
    .map((row) => row.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
let active;
let interceptedFrames;

// Restty exposes its original render loop only through requestAnimationFrame.
// Drain one scheduled turn per input; no source/renderer/algorithm is patched.
function manualFrames() {
  let id = 0;
  const pending = new Map();
  window.requestAnimationFrame = (fn) => {
    pending.set(++id, fn);
    return id;
  };
  window.cancelAnimationFrame = (key) => pending.delete(key);
  return {
    draw() {
      const batch = [...pending];
      for (const [key] of batch) pending.delete(key);
      for (const [, callback] of batch) callback(performance.now());
      assert(batch.length > 0, 'Restty did not schedule a render turn');
    },
    restore() {
      window.requestAnimationFrame = nativeRaf;
      window.cancelAnimationFrame = nativeCancel;
      pending.clear();
    },
    pending: () => pending.size,
  };
}

function readRestty(wasm, handle) {
  wasm.renderUpdate(handle);
  const state = wasm.getRenderState(handle);
  assert(state?.rows === config.rows && state.cols === config.cols, 'Restty grid differs');
  const rows = [];
  for (let y = 0; y < state.rows; y++) {
    let row = '';
    for (let x = 0; x < state.cols; x++) {
      const at = y * state.cols + x;
      if (state.wide?.[at] === 2 || state.wide?.[at] === 3) continue;
      // Reconstruct the same clusters consumed by Restty's renderer, skipping
      // wide tails while preserving each base plus its combining suffixes.
      const length = state.graphemeLen?.[at] ?? 0;
      row += String.fromCodePoint(state.codepoints[at] || 32);
      if (length) {
        const offset = state.graphemeOffset[at];
        row += String.fromCodePoint(...state.graphemeBuffer.subarray(offset, offset + length));
      }
    }
    rows.push(row);
  }
  return rows.join('\n');
}

async function ghostty() {
  await font();
  await initGhostty();
  const host = document.querySelector('#scene');
  host.replaceChildren();
  const terminal = new GhosttyTerminal({
    ...config,
    fontSize: 15,
    fontFamily: 'WraithBench',
    scrollback: 0,
    cursorBlink: false,
    theme: { background: '#101824', foreground: '#dfebf5' },
  });
  terminal.open(host);
  nativeCancel(terminal.animationFrameId);
  terminal.animationFrameId = undefined;
  const renderer = terminal.renderer;
  const originalMetrics = { ...renderer.getMetrics() };
  // Canvas2D's default line-height differs from xterm's. Keep the same 15px
  // face and horizontal metrics, but normalize line boxes/backing area.
  assert(originalMetrics.width === 9, 'Ghostty Web cell width differs');
  renderer.metrics = { ...originalMetrics, height: 20 };
  renderer.resize(config.cols, config.rows);
  const canvas = renderer.getCanvas();
  let renders = 0;
  return {
    type: 'ghostty-web',
    rendererName: 'canvas2d',
    terminal,
    canvas,
    geometry: {
      originalMetrics,
      normalizedCell: { width: 9, height: 20 },
      width: canvas.width,
      height: canvas.height,
    },
    parse: (bytes) => terminal.wasmTerm.write(bytes),
    draw: () => {
      renderer.render(terminal.wasmTerm, false, 0, terminal, 0);
      renders++;
    },
    // Canvas2D has no public GPU completion fence. Readback drains its command
    // stream, but prior updates can be coalesced. Never label this GPU FPS.
    finish: async () => {
      renderer.ctx.getImageData(0, 0, 1, 1);
    },
    submitted: () => renders,
    completion:
      'Canvas2D draw calls; 1px readback every 32 updates; intermediate paints may coalesce',
    gpuFenced: false,
    publicText: () =>
      Array.from(
        { length: config.rows },
        (_, y) =>
          terminal.buffer.active
            .getLine(terminal.buffer.active.viewportY + y)
            ?.translateToString(false) ?? '',
      ).join('\n'),
    text: () => {
      const cells = terminal.wasmTerm.getViewport();
      return Array.from({ length: config.rows }, (_, y) => {
        let text = '';
        for (let x = 0; x < config.cols; x++) {
          const cell = cells[y * config.cols + x];
          if (cell.width === 0) continue;
          text += cell.grapheme_len
            ? terminal.wasmTerm.getGraphemeString(y, x)
            : String.fromCodePoint(cell.codepoint || 32);
        }
        return text;
      }).join('\n');
    },
    dispose: () => terminal.dispose(),
  };
}

async function restty() {
  const bytes = await font();
  const host = document.querySelector('#scene');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { width: '2160px', height: '1600px' });
  canvas.width = 2160 * devicePixelRatio;
  canvas.height = 1600 * devicePixelRatio;
  host.append(canvas);
  interceptedFrames = manualFrames();
  const session = createResttyRuntimeSession();
  const wasm = await session.getWasm();
  let handle;
  const originalCreate = wasm.create.bind(wasm);
  wasm.create = (...args) => {
    handle = originalCreate(...args);
    return handle;
  };
  const core = await session.getWebGPUCore(canvas);
  assert(core, 'Restty WebGPU unavailable');
  let submissions = 0;
  const originalSubmit = core.device.queue.submit.bind(core.device.queue);
  core.device.queue.submit = (commands) => {
    submissions++;
    return originalSubmit(commands);
  };
  const runtime = createResttyRuntime({
    mount: { canvas, session },
    terminal: {
      renderer: 'webgpu',
      fonts: [{ data: bytes, name: 'WraithBench' }],
      fontSize: 15,
      fontSizeMode: 'em',
      ligatures: false,
      fontHinting: false,
      alphaBlending: 'native',
      maxScrollbackBytes: 0,
      autoResize: false,
      showResizeOverlay: false,
      attachWindowEvents: false,
      attachCanvasEvents: false,
      theme: parseGhosttyTheme('background = #101824\nforeground = #dfebf5'),
    },
  });
  await runtime.lifecycle.init();
  assert(runtime.render.getBackend() === 'webgpu', 'Restty fallback renderer');
  runtime.interaction.resize(config.cols, config.rows);
  interceptedFrames.draw();
  await core.device.queue.onSubmittedWorkDone();
  return {
    type: 'restty',
    rendererName: 'webgpu',
    runtime,
    canvas,
    wasm,
    handle,
    geometry: {
      width: canvas.width,
      height: canvas.height,
      cell: { width: canvas.width / config.cols, height: canvas.height / config.rows },
    },
    // Restty's published input accepts strings. Conversion from the identical
    // UTF-8 workload bytes is included rather than silently precomputing it.
    parse: (bytes) => runtime.io.sendInput(decoder.decode(bytes), 'pty'),
    draw: () => interceptedFrames.draw(),
    finish: () => core.device.queue.onSubmittedWorkDone(),
    submitted: () => submissions,
    completion: 'WebGPU submission per update; queue completion every 32 and final',
    gpuFenced: true,
    text: () => readRestty(wasm, handle),
    selectionText: () => wasm.getSelectionText(handle, 0, 0, config.rows - 1, config.cols - 1),
    dispose: () => {
      runtime.lifecycle.destroy();
      interceptedFrames.restore();
      core.device.queue.submit = originalSubmit;
      core.device.destroy();
    },
  };
}

async function setup(target, kind = 'complex') {
  active?.dispose();
  active = undefined;
  if (target === 'ghostty-web') active = await ghostty();
  else if (target === 'restty') active = await restty();
  else {
    active = await mount(target, config);
    active.canvas = active.canvas ?? active.renderer.canvas ?? active.renderer._canvas;
    if (target === 'webgl') {
      // Chromium's emulated DPR can disagree with ResizeObserver's physical
      // device-pixel box. This static benchmark fixes both the actual backing
      // canvas and renderer's cells, rather than trusting dimensions metadata.
      active.renderer._observerDisposable.clear();
      active.renderer.handleResize(config.cols, config.rows);
    }
    active.geometry = {
      width: active.dimensions.device.canvas.width,
      height: active.dimensions.device.canvas.height,
    };
    active.gpuFenced = true;
    active.completion = 'GPU submission per update; completion every 32 and final';
    active.rendererName = target === 'webgl' ? 'webgl2' : 'webgpu';
    if (target === 'webgl') {
      let draws = 0;
      let gpuDrawCalls = 0;
      const gl = active.renderer._gl;
      const issueDraw = gl.drawElementsInstanced.bind(gl);
      gl.drawElementsInstanced = (...args) => {
        gpuDrawCalls++;
        return issueDraw(...args);
      };
      const draw = active.draw;
      active.draw = () => {
        const before = gpuDrawCalls;
        draw();
        assert(gpuDrawCalls > before, 'xterm WebGL did not issue a GPU draw');
        draws++;
      };
      active.submitted = () => draws;
      active.gpuDrawCalls = () => gpuDrawCalls;
    }
  }
  active.inputs = Array.from({ length: 8 }, (_, i) => {
    const input = workload(
      config.cols,
      config.rows,
      i,
      kind === 'dense-no-combining' ? 'complex' : kind,
    );
    // Explicit additional common-subset case, applied equally to every target.
    // Keep the original complex workload and its Unicode differences as evidence.
    if (kind === 'dense-no-combining')
      input.bytes = encoder.encode(
        decoder
          .decode(input.bytes)
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, ''),
      );
    return input;
  });
  active.workload = kind;
  active.parse(active.inputs[0].bytes);
  active.draw();
  await active.finish();
  if (target === 'webgl') {
    active.draw();
    await active.finish();
  }
  active.assert?.();
  const joined = new Uint8Array(active.inputs.reduce((n, v) => n + v.bytes.length, 0));
  let offset = 0;
  for (const input of active.inputs) {
    joined.set(input.bytes, offset);
    offset += input.bytes.length;
  }
  const inputsSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', joined))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return { ...describe(), inputsSha256 };
}
function describe() {
  active.geometry.width = active.canvas.width;
  active.geometry.height = active.canvas.height;
  return {
    target: active.type,
    renderer: active.rendererName,
    geometry: active.geometry,
    text: normalized(active.text()),
    publicText: active.publicText ? normalized(active.publicText()) : undefined,
    completion: active.completion,
    gpuFenced: active.gpuFenced,
    bytesPerVariant: active.inputs?.map((v) => v.bytes.length),
  };
}
async function run({ frames = 256, warmup = 64 } = {}) {
  const a = active;
  for (let i = 0; i < warmup; i++) {
    a.parse(a.inputs[i % 8].bytes);
    a.draw();
    if ((i + 1) % 32 === 0) await a.finish();
  }
  await a.finish();
  const parsed = [],
    rendered = [],
    total = [];
  const before = a.submitted();
  const gpuDrawCallsBefore = a.gpuDrawCalls?.();
  const started = performance.now();
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    a.parse(a.inputs[i % 8].bytes);
    const t1 = performance.now();
    a.draw();
    const t2 = performance.now();
    parsed.push(t1 - t0);
    rendered.push(t2 - t1);
    total.push(t2 - t0);
    if ((i + 1) % 32 === 0) await a.finish();
  }
  await a.finish();
  const elapsedMs = performance.now() - started;
  const submissions = a.submitted() - before;
  a.geometry.width = a.canvas.width;
  a.geometry.height = a.canvas.height;
  assert(submissions === frames, `Expected ${frames} draws/submissions, got ${submissions}`);
  a.assert?.();
  return {
    frames,
    warmup,
    elapsedMs,
    updatesPerSecond: (frames * 1000) / elapsedMs,
    submissions,
    gpuDrawCalls:
      gpuDrawCallsBefore === undefined ? undefined : a.gpuDrawCalls() - gpuDrawCallsBefore,
    parseMs: percentiles(parsed),
    renderMs: percentiles(rendered),
    cpuMs: percentiles(total),
    gpuFenced: a.gpuFenced,
    completion: a.completion,
    text: normalized(a.text()),
    geometry: a.geometry,
  };
}
window.competitor = {
  ready: true,
  setup,
  run,
  describe,
  active: () => active,
  fixture: async (text) => {
    active.parse(encoder.encode('\x1bc\x1b[?25l' + text));
    // Reset/theme and atlas events can schedule asynchronous model invalidation.
    // Settle it before untimed pixel capture rather than reporting a stale frame.
    await nativeFrame();
    active.draw();
    await active.finish();
    await nativeFrame();
    active.draw();
    await active.finish();
    return describe();
  },
  dispose: () => {
    active?.dispose();
    active = undefined;
  },
  nativeFrame,
};
