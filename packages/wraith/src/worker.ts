/// <reference lib="webworker" />
import init, { Engine } from '../wasm/wraith_engine.js';
import type { Command, Reply } from './protocol.js';
import { percentile, type BenchmarkResult, type Workload } from './types.js';
const scope = self as unknown as DedicatedWorkerGlobalScope;
let engine: Engine | undefined;
let cols = 80,
  rows = 24;
let scheduled = false,
  visible = true,
  busy = false,
  disposed = false;
let raf = 0,
  holdTimer: ReturnType<typeof setTimeout> | undefined;
let samples: number[] = [],
  frameTimes: number[] = [];
let cursor = '';
let serial = Promise.resolve();
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
function post(reply: Reply, transfers: Transferable[] = []) {
  scope.postMessage(reply, transfers);
}
function result(id: number, value?: unknown) {
  post({ type: 'result', id, value });
}
function releaseAbandonedHold() {
  if (!engine || disposed) return;
  if (busy) {
    holdTimer = setTimeout(releaseAbandonedHold, 16);
    return;
  }
  engine.release_hold();
  schedule();
}
function drain() {
  for (const [kind, bytes] of engine!.take_events() as [number, Uint8Array][]) {
    if (kind === 0) post({ type: 'data', bytes }, [bytes.buffer as ArrayBuffer]);
    if (kind === 1) post({ type: 'title', title: decoder.decode(bytes) });
    if (kind === 2) post({ type: 'bell' });
    if (kind === 3) {
      clearTimeout(holdTimer);
      if (bytes[0]) holdTimer = setTimeout(releaseAbandonedHold, 150);
    }
  }
  post({
    type: 'modes',
    mouse: engine!.mode(1000) || engine!.mode(1002) || engine!.mode(1003) || engine!.mode(9),
  });
}
function draw(time: number, force = false) {
  const start = performance.now();
  if (engine!.render(time, force)) {
    samples.push(performance.now() - start);
    frameTimes.push(time);
    if (samples.length > 512) samples.shift();
    while (frameTimes.length && frameTimes[0]! < time - 1000) frameTimes.shift();
    const x = engine!.cursor_x,
      y = engine!.cursor_y,
      next = `${x},${y}`;
    if (next !== cursor) {
      cursor = next;
      post({ type: 'cursor', x, y });
    }
  }
  if (engine!.needs_present) schedule();
}
function schedule() {
  if (!engine || scheduled || disposed || !visible || busy) return;
  scheduled = true;
  raf = scope.requestAnimationFrame((time) => {
    scheduled = false;
    // An async GPU fence holds a Rust borrow across await. A previously queued
    // animation callback must not enter the engine until that borrow ends.
    if (busy || !engine || !visible || disposed) return;
    try {
      draw(time);
    } catch (error) {
      post({ type: 'error', error: String(error) });
    }
  });
}
const blinkTimer = setInterval(() => schedule(), 250);
const statsTimer = setInterval(() => {
  if (engine && !disposed && !busy)
    post({
      type: 'stats',
      values: Array.from(engine.metrics()),
      samples: [...samples],
      fps: frameTimes.filter((t) => t > performance.now() - 1000).length,
      adapter: engine.adapter,
    });
}, 500);

function payload(workload: Workload, iteration: number): Uint8Array {
  if (workload === 'sparse')
    return encoder.encode(
      `\x1b[${(iteration % rows) + 1};1H\x1b[38;5;${(iteration % 216) + 16}mframe ${String(iteration).padStart(8, '0')}\x1b[0m`,
    );
  if (workload === 'scroll')
    return encoder.encode(
      `\x1b[${rows};1H\r\n\x1b[38;5;${(iteration % 216) + 16}m${String(iteration).padStart(8, '0')} ${'stream '.repeat(Math.ceil(cols / 7)).slice(0, cols - 10)}\x1b[0m`,
    );
  let output = '\x1b[H';
  for (let row = 0; row < rows; row++) {
    output += `\x1b[${row + 1};1H\x1b[38;5;${((iteration + row) % 216) + 16}m`;
    for (let col = 0; col < cols; col++)
      output += String.fromCharCode(33 + ((col + row + iteration) % 94));
  }
  return encoder.encode(output + '\x1b[0m');
}
async function benchmark(options: {
  frames?: number;
  warmup?: number;
  workload?: Workload;
}): Promise<BenchmarkResult> {
  const count = Math.max(32, Math.min(10000, Math.floor(options.frames ?? 512)));
  const warmup = Math.max(0, Math.min(512, Math.floor(options.warmup ?? 64)));
  const workload = options.workload ?? 'dense';
  if (!['dense', 'sparse', 'scroll'].includes(workload))
    throw new Error('Unknown benchmark workload');
  if (engine!.mode(1049))
    throw new Error('Run benchmarks outside an active full-screen terminal application');
  if (engine!.mode(2026))
    throw new Error('Wait for synchronized output to finish before benchmarking');
  const cursorWasVisible = engine!.mode(25);
  busy = true;
  clearTimeout(holdTimer);
  if (scheduled) {
    scope.cancelAnimationFrame(raf);
    scheduled = false;
  }
  const durations: number[] = [];
  let bytes = 0,
    completed = 0;
  try {
    engine!.write(encoder.encode('\x1b[?1049h\x1b[?25l'));
    // Generate inputs outside the timed region. The same 64-frame cycle is
    // reproducible; timestamps measure parser + snapshot + encode + submit.
    const inputs = Array.from({ length: 64 }, (_, i) => payload(workload, i));
    for (let i = 0; i < warmup; i++) {
      engine!.write(inputs[i % 64]!);
      engine!.render(performance.now(), true);
      if ((i + 1) % 32 === 0) await engine!.fence();
    }
    await engine!.fence();
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      const input = inputs[i % 64]!,
        before = performance.now();
      engine!.write(input);
      const rendered = engine!.render(performance.now(), true);
      durations.push(performance.now() - before);
      bytes += input.byteLength;
      if (rendered) completed++;
      if ((i + 1) % 32 === 0) await engine!.fence();
    }
    await engine!.fence();
    const elapsedMs = performance.now() - start;
    return {
      workload,
      frames: completed,
      cols,
      rows,
      elapsedMs,
      fencedFramesPerSecond: (completed * 1000) / elapsedMs,
      cpuP50Ms: percentile(durations, 0.5),
      cpuP95Ms: percentile(durations, 0.95),
      cpuP99Ms: percentile(durations, 0.99),
      inputMiBPerSecond: bytes / (1024 * 1024) / (elapsedMs / 1000),
      adapter: engine!.adapter,
      userAgent: scope.navigator.userAgent,
    };
  } finally {
    engine!.write(encoder.encode('\x1b[?1049l' + (cursorWasVisible ? '\x1b[?25h' : '\x1b[?25l')));
    busy = false;
    drain();
    schedule();
  }
}
async function handle(command: Command) {
  if (command.type === 'init') {
    await init();
    cols = command.cols;
    rows = command.rows;
    engine = await Engine.create(
      command.canvas,
      command.font,
      cols,
      rows,
      command.size,
      command.lineHeight,
      command.history,
    );
    for (const font of command.fonts) engine.add_font(font);
    engine.theme(command.theme[0]!, command.theme[1]!, command.theme[2]!);
    post({
      type: 'ready',
      width: engine.cell_width,
      height: engine.cell_height,
      adapter: engine.adapter,
    });
    schedule();
    return;
  }
  if (!engine || disposed) throw new Error('Wraith engine is not running');
  switch (command.type) {
    case 'write':
      engine.write(command.bytes);
      drain();
      schedule();
      result(command.id);
      break;
    case 'resize':
      engine.resize(command.cols, command.rows);
      cols = command.cols;
      rows = command.rows;
      schedule();
      result(command.id);
      break;
    case 'key':
      engine.key(command.key, command.mods, command.action, command.text, command.unshifted);
      drain();
      break;
    case 'mouse':
      engine.mouse(
        command.action,
        command.button,
        command.mods,
        command.x,
        command.y,
        command.pressed,
      );
      drain();
      break;
    case 'scroll':
      engine.scroll(command.delta);
      schedule();
      break;
    case 'select':
      engine.select(command.x1, command.y1, command.x2, command.y2);
      schedule();
      break;
    case 'paste': {
      // Sanitize terminal control characters and bracketed-paste terminators.
      const text = command.text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
      const framed = engine.mode(2004) ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r?\n/g, '\r');
      const bytes = encoder.encode(framed);
      post({ type: 'data', bytes }, [bytes.buffer]);
      result(command.id);
      break;
    }
    case 'focus':
      if (engine.mode(1004)) {
        const bytes = encoder.encode(command.focused ? '\x1b[I' : '\x1b[O');
        post({ type: 'data', bytes }, [bytes.buffer]);
      }
      break;
    case 'text':
      result(command.id, engine.text(command.selected));
      break;
    case 'link':
      result(command.id, engine.link(command.x, command.y));
      break;
    case 'theme':
      engine.theme(command.colors[0]!, command.colors[1]!, command.colors[2]!);
      schedule();
      break;
    case 'flush':
      busy = true;
      if (scheduled) {
        scope.cancelAnimationFrame(raf);
        scheduled = false;
      }
      try {
        draw(performance.now(), true);
        await engine.fence();
        result(command.id);
      } finally {
        busy = false;
        schedule();
      }
      break;
    case 'benchmark':
      result(command.id, await benchmark(command.options));
      break;
    case 'visibility':
      visible = command.visible;
      if (visible) schedule();
      break;
    case 'dispose':
      disposed = true;
      clearInterval(blinkTimer);
      clearInterval(statsTimer);
      clearTimeout(holdTimer);
      if (scheduled) scope.cancelAnimationFrame(raf);
      engine.free();
      engine = undefined;
      result(command.id);
      scope.close();
      break;
  }
}
scope.onmessage = (event: MessageEvent<Command>) => {
  const command = event.data;
  serial = serial
    .then(() => handle(command))
    .catch((error) => {
      if ('id' in command) post({ type: 'result', id: command.id, error: String(error) });
      else post({ type: 'error', error: String(error) });
    });
};
