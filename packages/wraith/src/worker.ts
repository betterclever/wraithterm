/// <reference lib="webworker" />
import init, { Engine } from '../wasm/wraith_engine.js';
import type { Command, Reply } from './protocol.js';
import { percentile, type BenchmarkResult, type Workload } from './types.js';
const scope = self as unknown as DedicatedWorkerGlobalScope;
const ready = init();
let initializing: Promise<unknown> = Promise.resolve();
type Endpoint = { postMessage(reply: Reply, transfers: Transferable[]): void };

/** One terminal: its engine, scheduling, search and fences, replying through
 * `endpoint`. A dedicated worker runs one; a pooled worker runs one per port. */
function createSession(endpoint: Endpoint, onClose: () => void) {
  let engine: Engine | undefined;
  let cols = 80,
    rows = 24;
  let scheduled = false,
    visible = true,
    busy = false,
    disposed = false;
  let forceNextFrame = false;
  let raf = 0,
    holdTimer: ReturnType<typeof setTimeout> | undefined;
  let samples: number[] = [],
    frameTimes: number[] = [];
  let cursor = '';
  let mouseTracking = false;
  let observeRender = false,
    renderedFrames = 0;
  let serial = Promise.resolve();
  let searchGeneration = 0;
  let searchRequest: number | undefined;
  // A posted task yields to writes/input without the nested-timer 4 ms clamp.
  // Coalesce superseded work so cancelled searches do not leave a task backlog.
  const searchTasks = new MessageChannel();
  let nextSearchStep: (() => void) | undefined;
  searchTasks.port1.onmessage = () => {
    const step = nextSearchStep;
    nextSearchStep = undefined;
    step?.();
  };
  function queueSearchStep(step: () => void) {
    const pending = nextSearchStep !== undefined;
    nextSearchStep = step;
    if (!pending) searchTasks.port2.postMessage(null);
  }
  function search(needle: string, direction: number, id: number) {
    // New searches cancel pending requests, rather than leaving callers hanging.
    if (searchRequest !== undefined)
      post({ type: 'result', id: searchRequest, error: 'Search superseded' });
    const generation = ++searchGeneration;
    engine!.search(needle, needle ? 0 : 4);
    if (!needle) {
      result(id, { total: 0, index: -1 });
      searchRequest = undefined;
      schedule();
      return;
    }
    searchRequest = id;
    const step = () => {
      if (disposed || generation !== searchGeneration) return;
      // Enter through the same serial queue as writes, resize and GPU fences.
      serial = serial
        .then(() => {
          if (disposed || generation !== searchGeneration) return;
          // Amortize message/ABI overhead, but yield after a short CPU slice.
          // One bridge step remains bounded; never hold a borrow across a yield.
          const deadline = performance.now() + 2;
          let status: Uint32Array;
          do {
            status = engine!.search('', 1);
          } while (status[0] !== 2 && performance.now() < deadline);
          if (status[0] !== 2) {
            queueSearchStep(step);
            return;
          }
          const selected = engine!.search('', direction > 0 ? 2 : 3);
          searchRequest = undefined;
          result(id, {
            total: selected[1]!,
            index: selected[2] === 0xffffffff ? -1 : selected[2]!,
          });
          schedule();
        })
        .catch((error) => {
          if (generation !== searchGeneration) return;
          searchRequest = undefined;
          post({ type: 'result', id, error: String(error) });
        });
    };
    queueSearchStep(step);
  }
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  function post(reply: Reply, transfers: Transferable[] = []) {
    endpoint.postMessage(reply, transfers);
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
    const mouse = engine!.mode(1000) || engine!.mode(1002) || engine!.mode(1003) || engine!.mode(9);
    if (mouse !== mouseTracking) {
      mouseTracking = mouse;
      post({ type: 'modes', mouse });
    }
  }
  function draw(time: number, force = false) {
    // A restored canvas may need presentation even when terminal state is clean.
    // Consume this only inside the guarded draw path, including explicit flush.
    force ||= forceNextFrame;
    const start = performance.now();
    if (engine!.render(time, force)) {
      forceNextFrame = false;
      renderedFrames++;
      if (observeRender) post({ type: 'render', frame: renderedFrames });
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
  function schedule(force = false) {
    forceNextFrame ||= force;
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
        effectPasses: engine.effect_passes,
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
      await ready;
      cols = command.cols;
      rows = command.rows;
      // Terminals in a pooled worker share one GPU device; initialize them one
      // at a time so their pipeline validation scopes cannot interleave.
      const created = initializing.then(() =>
        Engine.create(
          command.canvas,
          command.font,
          cols,
          rows,
          command.size,
          command.lineHeight,
          command.history,
        ),
      );
      initializing = created.then(
        () => undefined,
        () => undefined,
      );
      engine = await created;
      for (const font of command.fonts) engine.add_font(font);
      if (command.ligatures) engine.set_ligatures(true);
      if (command.imageStorageLimit !== undefined)
        engine.set_image_limit(Math.max(0, Math.floor(command.imageStorageLimit)));
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
        post({ type: 'written', ids: command.ids });
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
      case 'font':
        result(
          command.id,
          Array.from(
            engine.configure_font(command.font, command.fonts, command.size, command.lineHeight),
          ),
        );
        cursor = '';
        schedule();
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
      case 'selection':
        engine.select_mode(command.x1, command.y1, command.x2, command.y2, command.mode ?? 0);
        schedule();
        if (command.type === 'selection') result(command.id);
        break;
      case 'search':
        search(command.needle, command.direction, command.id);
        break;
      case 'paste': {
        // Sanitize terminal control characters and bracketed-paste terminators.
        const text = command.text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
        const framed = engine.mode(2004)
          ? `\x1b[200~${text}\x1b[201~`
          : text.replace(/\r?\n/g, '\r');
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
        if (visible === command.visible) break;
        visible = command.visible;
        if (visible) schedule(true);
        else if (scheduled) {
          scope.cancelAnimationFrame(raf);
          scheduled = false;
        }
        break;
      case 'observe-render':
        observeRender = command.enabled;
        break;
      case 'effects':
        // Pipeline validation awaits the GPU while holding the engine borrow;
        // pause frames exactly as a fence does.
        busy = true;
        if (scheduled) {
          scope.cancelAnimationFrame(raf);
          scheduled = false;
        }
        try {
          await engine.set_effects(new Float32Array(command.params), command.shader);
          result(command.id);
        } catch (error) {
          // Compiler messages pass through unprefixed; the terminal keeps running.
          post({
            type: 'result',
            id: command.id,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          busy = false;
          schedule(true);
        }
        break;
      case 'effect-mouse':
        engine.set_effect_mouse(
          command.mouse[0]!,
          command.mouse[1]!,
          command.mouse[2]!,
          command.mouse[3]!,
        );
        schedule();
        break;
      case 'dispose':
        disposed = true;
        searchGeneration++;
        nextSearchStep = undefined;
        searchTasks.port1.close();
        searchTasks.port2.close();
        clearInterval(blinkTimer);
        clearInterval(statsTimer);
        clearTimeout(holdTimer);
        if (scheduled) scope.cancelAnimationFrame(raf);
        engine.free();
        engine = undefined;
        result(command.id);
        onClose();
        break;
    }
  }
  return (command: Command) => {
    serial = serial
      .then(() => handle(command))
      .catch((error) => {
        if (command.type === 'write')
          post({ type: 'written', ids: command.ids, error: String(error) });
        else if ('id' in command) post({ type: 'result', id: command.id, error: String(error) });
        else post({ type: 'error', error: String(error) });
      });
  };
}

// Pooled workers receive one MessagePort per terminal; dedicated workers take
// commands on the worker scope itself.
let dedicated: ((command: Command) => void) | undefined;
scope.onmessage = (event: MessageEvent<Command | { type: 'attach'; port: MessagePort }>) => {
  const message = event.data;
  if (message.type === 'attach') {
    const port = message.port;
    const receive = createSession(port, () => port.close());
    port.onmessage = (e: MessageEvent<Command>) => receive(e.data);
    return;
  }
  dedicated ??= createSession(scope, () => scope.close());
  dedicated(message);
};
