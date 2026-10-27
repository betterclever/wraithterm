/// <reference lib="webworker" />
import init, { Engine, Headless } from '../wasm/wraith_engine.js';
import { MessageBatch, nextTask } from './batch.js';
import type { Command, PoolMessage, PoolReply, Reply, SurfaceReply } from './protocol.js';
import { SharedHost, type SharedSlot } from './shared-host.js';
import { percentile, type BenchmarkResult, type Workload } from './types.js';
import { createAccessibility } from './worker-accessibility.js';
import { createCommandTracker } from './worker-commands.js';
const scope = self as unknown as DedicatedWorkerGlobalScope;
const ready = init();
let initializing: Promise<unknown> = Promise.resolve();
// V8 runs each Wasm function on its baseline compiler first and switches to
// optimized code only on a later call, after enough work has run. The parser
// is entered once per write batch, so a terminal's first multi-megabyte burst
// would parse entirely on baseline code, and its first frame of text would
// rasterize every glyph on baseline code too. The first terminal in each
// worker therefore spends idle time after it is ready rasterizing printable
// ASCII into its atlas and running a scratch parser over a short mixed stream
// in small calls, in 1 ms steps taken only after 8 ms without commands.
let warmed = false;
const warmStream = (() => {
  let text = '';
  for (let i = 0; i < 48; i++)
    text +=
      `\x1b[38;2;${i * 5};${255 - i * 5};${(i * 37) & 255};48;2;${(i * 11) & 255};${i};${i * 3}m\u2580` +
      `\x1b[0m\x1b[1;3${i % 8}m line ${i} \u25cf \u00b7 \u2713 \x1b[38;5;${i}m ascii text \x1b[0m` +
      `\x1b[${(i % 20) + 1};${(i % 70) + 1}H\x1b[K\x1b[2m done\x1b[22m\r\n`;
  return text;
})();
type Endpoint = { postMessage(reply: Reply, transfers: Transferable[]): void };
// WebSocketStream is not in TypeScript's lib yet; Chrome ships it.
interface SocketStream {
  opened: Promise<{
    readable: ReadableStream<ArrayBuffer | string>;
    writable: WritableStream<Uint8Array | string>;
  }>;
  closed: Promise<{ closeCode?: number; reason?: string }>;
  close(info?: { closeCode?: number; reason?: string }): void;
}
type SocketStreamClass = new (url: string, options?: { protocols?: string[] }) => SocketStream;
/** A WebSocket owned by the worker: output is parsed here, never on the page. */
interface Link {
  id: number;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}
// Yield to other tasks (input commands, animation frames) at least this often
// while a stream delivers already-buffered chunks as resolved promises.
// A posted message is a task without the nested-timer 4 ms clamp.
const SLICE_MS = 4;
const yields = new MessageChannel();
const yielded: (() => void)[] = [];
yields.port1.onmessage = () => yielded.shift()?.();
const yieldTask = () =>
  new Promise<void>((resolve) => {
    yielded.push(resolve);
    yields.port2.postMessage(null);
  });

// Benchmark feeds (see the 'feed' command): every feeding terminal parses its
// next chunk once per worker animation frame, before that frame renders.
const feeders = new Set<() => void>();
let feeding = false;
function startFeeding(step: () => void) {
  feeders.add(step);
  if (feeding) return;
  feeding = true;
  const frame = () => {
    if (!feeders.size) {
      feeding = false;
      return;
    }
    for (const feed of feeders) feed();
    scope.requestAnimationFrame(frame);
  };
  scope.requestAnimationFrame(frame);
}

/** One terminal: its engine, scheduling, search and fences, replying through
 * `endpoint`. A dedicated worker runs one; a pooled worker one per attached terminal. */
function createSession(
  endpoint: Endpoint,
  onClose: () => void,
  shared?: { host: SharedHost; id: number },
) {
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
  // Latency tracing (benchmarks only).
  let tracing = false,
    traceFrame = false;
  // A write to an idle terminal (no frame for two frame intervals), such as a
  // keystroke's echo, renders at once instead of on the next animation frame:
  // Chrome's compositor draws and swaps a canvas frame that arrives between
  // vsyncs straight away, so the echo reaches the display about one frame
  // sooner. Busier output stays on animation frames: mixing in off-phase
  // frames there delayed later frames in measurement (see
  // docs/benchmarks/input-latency). `immediate` is switchable for A/B runs.
  let immediate = true;
  const IDLE_FRAMES = 2;
  // When the last frame was rendered, and the display's frame interval as
  // estimated from consecutive animation frames.
  let lastDraw = -Infinity,
    lastAnimationFrame = 0,
    frameInterval = 1000 / 60;
  let serial = Promise.resolve();
  let link: Link | undefined;
  // Benchmark feed: chunks replayed in this worker, one per animation frame.
  let feedChunks: Uint8Array[] = [],
    fed = 0;
  const feedStep = () => {
    if (disposed || !engine) return feeders.delete(feedStep);
    // A benchmark or flush holds the engine; skip this frame.
    if (busy) return;
    try {
      engine.write(feedChunks[fed % feedChunks.length]!);
      fed++;
      drain();
      schedule();
    } catch (error) {
      feeders.delete(feedStep);
      fatal(error);
    }
  };
  let searchGeneration = 0;
  let reducedMotion = false;
  // Screen-reader mirror and announcements; inert until a mounted terminal enables them.
  const a11y = createAccessibility(
    () =>
      !engine || busy || disposed || engine.mode(2026)
        ? undefined
        : {
            text: engine.text(false),
            rows,
            cursor: engine.cursor_y,
            alternate: engine.mode(1049) || engine.mode(1047) || engine.mode(47),
          },
    (task) => {
      // Accessibility is advisory: a failed sample must not fail the terminal.
      serial = serial.then(task).catch((error) => console.error('Wraith accessibility', error));
    },
    (reply) => post(reply),
  );
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
          a11y.rebaseline();
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
  function trace(stage: Extract<Reply, { type: 'trace' }>['stage'], info?: string) {
    post({ type: 'trace', stage, time: performance.timeOrigin + performance.now(), info });
  }
  /** The page fails the terminal on any reported error. A pooled worker
   * outlives that terminal, so drop its socket here rather than keep reading
   * (and keep the remote session alive) for a page that has gone. */
  function fatal(error: unknown) {
    link?.close(1000, 'Terminal failed');
    link = undefined;
    post({ type: 'error', error: String(error) });
  }
  /** Engine output: replies, keys, paste. The worker socket sends it first. */
  function output(bytes: Uint8Array) {
    link?.send(bytes);
    post({ type: 'data', bytes }, [bytes.buffer as ArrayBuffer]);
  }
  /** Parse socket output in arrival order, through the same queue as writes,
   * resize and GPU fences. Resolves once the bytes are parsed. */
  function ingest(from: Link, data: ArrayBuffer | Uint8Array | string): Promise<void> {
    serial = serial
      .then(() => {
        if (link !== from || !engine || disposed) return;
        engine.write(
          typeof data === 'string'
            ? encoder.encode(data)
            : data instanceof Uint8Array
              ? data
              : new Uint8Array(data),
        );
        // Socket output reaches screen readers like written output does.
        a11y.changed();
        drain();
        schedule();
      })
      .catch(fatal);
    return serial;
  }
  function openLink(id: number, url: string, protocols: string[], stream: boolean) {
    link?.close(1000, 'Replaced');
    const event = (reply: Omit<Extract<Reply, { type: 'socket' }>, 'type' | 'link'>) =>
      post({ type: 'socket', link: id, ...reply });
    // Close reports wait until every byte that arrived before it is parsed.
    const closed = (code: number, reason: string, wasClean: boolean, error?: string) =>
      void serial.then(() => {
        if (link === current) link = undefined;
        if (error !== undefined) event({ event: 'error', error });
        event({ event: 'close', code, reason, wasClean });
      });
    let queued: (Uint8Array | string)[] | undefined = [];
    let current: Link;
    const Stream = (self as unknown as { WebSocketStream?: SocketStreamClass }).WebSocketStream;
    try {
      if (stream && Stream) {
        // Streams read only when asked, so a busy parser pauses the socket and
        // TCP pushes back on the server instead of queueing in this worker.
        const socket = new Stream(url, { protocols });
        let writer: WritableStreamDefaultWriter<Uint8Array | string> | undefined;
        let ended = false;
        current = {
          id,
          send(data) {
            if (ended) return;
            // Writes may complete after the caller's buffer is transferred.
            const copy = typeof data === 'string' ? data : data.slice();
            if (queued) queued.push(copy);
            else void writer!.write(copy).catch(() => {});
          },
          close(code, reason) {
            if (ended) return;
            ended = true;
            try {
              socket.close({ closeCode: code, reason });
            } catch (error) {
              event({ event: 'error', error: String(error) });
              socket.close();
            }
          },
        };
        void (async () => {
          let failure: unknown;
          try {
            const { readable, writable } = await socket.opened;
            writer = writable.getWriter();
            for (const data of queued!) void writer.write(data).catch(() => {});
            queued = undefined;
            event({ event: 'open', transport: 'stream' });
            const reader = readable.getReader();
            let slice = performance.now();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              await ingest(current, value);
              if (performance.now() - slice > SLICE_MS) {
                await yieldTask();
                slice = performance.now();
              }
            }
          } catch (error) {
            failure = error;
          }
          ended = true;
          let code = 1006,
            reason = '',
            clean = false;
          try {
            const info = await socket.closed;
            code = info.closeCode ?? 1005;
            reason = info.reason ?? '';
            clean = true;
          } catch (error) {
            failure ??= error;
          }
          closed(code, reason, clean, failure === undefined ? undefined : String(failure));
        })();
      } else {
        const socket = new WebSocket(url, protocols);
        socket.binaryType = 'arraybuffer';
        let failed = false;
        current = {
          id,
          send(data) {
            if (queued) queued.push(typeof data === 'string' ? data : data.slice());
            else if (socket.readyState === WebSocket.OPEN) socket.send(data);
          },
          close(code, reason) {
            try {
              socket.close(code, reason);
            } catch (error) {
              event({ event: 'error', error: String(error) });
              socket.close();
            }
          },
        };
        socket.onopen = () => {
          for (const data of queued!) socket.send(data);
          queued = undefined;
          event({ event: 'open', transport: 'events' });
        };
        socket.onmessage = (message: MessageEvent<ArrayBuffer | string>) =>
          void ingest(current, message.data);
        socket.onerror = () => (failed = true);
        socket.onclose = (info) =>
          closed(
            info.code,
            info.reason,
            info.wasClean,
            failed ? 'WebSocket connection failed' : undefined,
          );
      }
    } catch (error) {
      // An invalid URL or protocol throws synchronously.
      current = { id, send() {}, close() {} };
      link = current;
      closed(1006, '', false, String(error));
      return;
    }
    link = current;
  }
  function result(id: number, value?: unknown) {
    post({ type: 'result', id, value });
  }
  const commands = createCommandTracker(() => engine, post);
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
      if (kind === 0) output(bytes);
      if (kind === 1) post({ type: 'title', title: decoder.decode(bytes) });
      if (kind === 2) post({ type: 'bell' });
      if (kind === 3) {
        clearTimeout(holdTimer);
        if (bytes[0]) holdTimer = setTimeout(releaseAbandonedHold, 150);
      }
      if (kind === 5) commands.event(bytes);
    }
    const mouse = engine!.mode(1000) || engine!.mode(1002) || engine!.mode(1003) || engine!.mode(9);
    if (mouse !== mouseTracking) {
      mouseTracking = mouse;
      post({ type: 'modes', mouse });
    }
  }
  function draw(time: number, force = false): boolean {
    // A restored canvas may need presentation even when terminal state is clean.
    // Consume this only inside the guarded draw path, including explicit flush.
    force ||= forceNextFrame;
    const start = performance.now();
    // A fixed time freezes cursor and SGR blink phases in their visible state.
    const rendered = engine!.render(reducedMotion ? 0 : time, force);
    if (rendered) {
      forceNextFrame = false;
      renderedFrames++;
      lastDraw = performance.now();
      if (traceFrame) {
        traceFrame = false;
        trace('submit');
        engine!.on_submitted_work_done(() => trace('gpu'));
        scope.requestAnimationFrame(() => trace('frame'));
      }
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
    commands.update();
    if (engine!.needs_present) schedule();
    return rendered;
  }
  // On a shared surface the worker's host draws staged frames in one pass.
  const slot: SharedSlot | undefined = shared && {
    id: shared.id,
    engine: () => (disposed ? undefined : engine),
    busy: () => busy,
    visible: () => visible && !disposed,
    render(time) {
      try {
        return draw(time);
      } catch (error) {
        post({ type: 'error', error: String(error) });
        return false;
      }
    },
  };
  function present() {
    if (slot) shared!.host.presentNow(slot);
  }
  function schedule(force = false) {
    forceNextFrame ||= force;
    if (slot) {
      if (engine && !disposed && visible && !busy) shared!.host.request(slot);
      return;
    }
    if (!engine || scheduled || disposed || !visible || busy) return;
    scheduled = true;
    raf = scope.requestAnimationFrame((time) => {
      scheduled = false;
      const delta = time - lastAnimationFrame;
      lastAnimationFrame = time;
      // Consecutive frames only: skipped frames would overestimate the interval.
      if (delta > 2 && delta < frameInterval * 1.5) frameInterval += (delta - frameInterval) * 0.2;
      // An async GPU fence holds a Rust borrow across await. A previously queued
      // animation callback must not enter the engine until that borrow ends.
      if (busy || !engine || !visible || disposed) return;
      try {
        draw(time);
      } catch (error) {
        fatal(error);
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
        present();
        if ((i + 1) % 32 === 0) await engine!.fence();
      }
      await engine!.fence();
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        const input = inputs[i % 64]!,
          before = performance.now();
        engine!.write(input);
        const rendered = engine!.render(performance.now(), true);
        present();
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
  let lastCommand = 0;
  function warmUp() {
    if (warmed) return;
    warmed = true;
    const tasks = new MessageChannel();
    const chunk = encoder.encode(warmStream);
    let glyph = 0,
      parsed = 0,
      scratch: Headless | undefined;
    const finish = () => {
      scratch?.free();
      scratch = undefined;
      tasks.port1.close();
    };
    const step = () => {
      if (disposed || !engine) return finish();
      // Stay out of the way of active terminals: wait for a quiet moment.
      const quiet = performance.now() - lastCommand;
      if (quiet < 8) {
        setTimeout(() => tasks.port2.postMessage(null), 8 - quiet);
        return;
      }
      const deadline = performance.now() + 1;
      try {
        while (performance.now() < deadline) {
          if (glyph >= 0) glyph = engine.prefill_glyphs(glyph, 4);
          else if (parsed < 48) {
            scratch ??= new Headless(80, 24, 200);
            scratch.write(chunk);
            if (++parsed % 8 === 0) scratch.text();
          } else return finish();
        }
      } catch {
        // Warm-up only; real work is unaffected.
        return finish();
      }
      tasks.port2.postMessage(null);
    };
    tasks.port1.onmessage = () => {
      serial = serial.then(step);
    };
    tasks.port2.postMessage(null);
  }
  async function handle(command: Command) {
    if (command.type === 'init') {
      await ready;
      cols = command.cols;
      rows = command.rows;
      // Terminals in a pooled worker share one GPU device; initialize them one
      // at a time so their pipeline validation scopes cannot interleave.
      const surface = shared ? await shared.host.ready : undefined;
      const created = initializing.then(() =>
        surface
          ? Engine.create_shared(
              surface.context(),
              command.font,
              command.fonts,
              cols,
              rows,
              command.size,
              command.lineHeight,
              command.history,
              !!command.ligatures,
            )
          : Engine.create(
              command.canvas!,
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
      if (!surface) {
        for (const font of command.fonts) engine.add_font(font);
        if (command.ligatures) engine.set_ligatures(true);
      }
      if (command.imageStorageLimit !== undefined)
        engine.set_image_limit(Math.max(0, Math.floor(command.imageStorageLimit)));
      engine.theme(command.theme[0]!, command.theme[1]!, command.theme[2]!);
      post({
        type: 'ready',
        width: engine.cell_width,
        height: engine.cell_height,
        adapter: engine.adapter,
      });
      if (slot) shared!.host.register(slot);
      schedule();
      warmUp();
      return;
    }
    if (!engine || disposed) throw new Error('Wraith engine is not running');
    switch (command.type) {
      case 'write': {
        const marked = tracing && command.bytes.some((b) => b >= 0x61 && b <= 0x7a);
        engine.write(command.bytes);
        a11y.changed();
        drain();
        if (marked) {
          trace('parsed');
          traceFrame = true;
        }
        post({ type: 'written', ids: command.ids });
        // A shared surface draws every terminal in its host's single pass.
        if (
          immediate &&
          !slot &&
          visible &&
          !busy &&
          performance.now() - lastDraw >= frameInterval * IDLE_FRAMES
        ) {
          if (scheduled) {
            scope.cancelAnimationFrame(raf);
            scheduled = false;
          }
          try {
            draw(performance.now());
          } catch (error) {
            fatal(error);
          }
        } else schedule();
        break;
      }
      case 'resize':
        engine.resize(command.cols, command.rows);
        cols = command.cols;
        rows = command.rows;
        a11y.rebaseline();
        schedule();
        result(command.id);
        break;
      case 'key':
        if (tracing) trace('key', command.text);
        engine.key(command.key, command.mods, command.action, command.text, command.unshifted);
        // Printable keys, Backspace and Delete echo into the cursor row.
        if (command.action !== 0)
          a11y.typed(
            (!!command.text && !(command.mods & 6)) || command.key === 53 || command.key === 68,
          );
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
        a11y.rebaseline();
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
        a11y.typed(true);
        output(encoder.encode(framed));
        result(command.id);
        break;
      }
      case 'focus':
        if (engine.mode(1004)) output(encoder.encode(command.focused ? '\x1b[I' : '\x1b[O'));
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
          present();
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
      case 'commands':
        result(command.id, commands.list());
        break;
      case 'command-text':
        result(command.id, commands.text(command.block, command.input));
        break;
      case 'jump-prompt': {
        const offset = commands.jump(command.direction);
        if (offset >= 0) schedule();
        result(command.id, offset >= 0);
        break;
      }
      case 'observe-render':
        observeRender = command.enabled;
        break;
      case 'feed':
        if (command.chunks !== undefined) {
          feeders.delete(feedStep);
          feedChunks = command.chunks ?? [];
          if (feedChunks.length) startFeeding(feedStep);
        }
        result(command.id, fed);
        break;
      case 'a11y':
        reducedMotion = command.reducedMotion;
        a11y.configure(command);
        schedule(true);
        break;
      case 'read': {
        if (command.scope === 'screen') {
          result(command.id, engine.text(false));
          break;
        }
        // Select all, format, and clear in one task: no frame can paint the
        // temporary selection. Ghostty's formatter joins soft wraps.
        engine.select_mode(0, 0, 0, 0, 4);
        let text: string;
        try {
          text = engine.text(true);
        } finally {
          engine.select_mode(-1, 0, 0, 0, 0);
        }
        schedule();
        result(command.id, text);
        break;
      }
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
      case 'trace':
        if (command.enabled !== undefined) tracing = command.enabled;
        if (command.immediate !== undefined) immediate = command.immediate;
        break;
      case 'socket-open':
        openLink(command.link, command.url, command.protocols, command.stream);
        break;
      case 'socket-send':
        if (link?.id === command.link) link.send(command.data);
        break;
      case 'socket-close':
        if (link?.id === command.link) link.close(command.code, command.reason);
        break;
      case 'dispose':
        disposed = true;
        feeders.delete(feedStep);
        a11y.dispose();
        link?.close(1000, 'Terminal disposed');
        link = undefined;
        searchGeneration++;
        nextSearchStep = undefined;
        searchTasks.port1.close();
        searchTasks.port2.close();
        clearInterval(blinkTimer);
        clearInterval(statsTimer);
        clearTimeout(holdTimer);
        if (scheduled) scope.cancelAnimationFrame(raf);
        if (slot) shared!.host.unregister(slot);
        engine.free();
        engine = undefined;
        result(command.id);
        onClose();
        break;
    }
  }
  return (command: Command) => {
    lastCommand = performance.now();
    serial = serial
      .then(() => handle(command))
      .catch((error) => {
        if (command.type === 'write')
          post({ type: 'written', ids: command.ids, error: String(error) });
        else if ('id' in command) post({ type: 'result', id: command.id, error: String(error) });
        else fatal(error);
      });
  };
}

// Pooled workers multiplex their terminals over the worker scope: commands
// arrive in per-task batches tagged with the terminal's id, and replies leave
// the same way. Dedicated workers take commands on the worker scope itself.
let dedicated: ((command: Command) => void) | undefined;
const sessions = new Map<number, (command: Command) => void>();
const replies = new MessageBatch<[number, Reply]>((items, transfers) => {
  try {
    scope.postMessage({ type: 'replies', items } satisfies PoolReply, transfers);
  } catch {
    // Resend individually so one uncloneable reply cannot drop the rest.
    for (const item of items)
      try {
        scope.postMessage({ type: 'replies', items: [item] } satisfies PoolReply);
      } catch (error) {
        scope.postMessage({
          type: 'replies',
          items: [[item[0], { type: 'error', error: String(error) }]],
        } satisfies PoolReply);
      }
  }
}, nextTask());
// A shared-surface pool sends this worker one page-sized canvas first.
let host: SharedHost | undefined;
scope.onmessage = (event: MessageEvent<Command | PoolMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'attach': {
      const id = message.id;
      sessions.set(
        id,
        createSession(
          { postMessage: (reply, transfers) => replies.push([id, reply], transfers) },
          () => sessions.delete(id),
          message.shared && host ? { host, id } : undefined,
        ),
      );
      return;
    }
    case 'batch':
      for (const [id, command] of message.items) sessions.get(id)?.(command);
      return;
    case 'surface':
      host = new SharedHost(scope, ready, message.canvas, message.width, message.height);
      return;
    case 'surface-size':
      host?.resize(message.width, message.height);
      return;
    case 'geometry':
      host?.geometry(message.data);
      return;
    case 'surface-effects': {
      const id = message.id;
      const done = (error?: unknown) =>
        scope.postMessage({
          type: 'surface-effects-result',
          id,
          ...(error !== undefined && {
            error: error instanceof Error ? error.message : String(error),
          }),
        } satisfies SurfaceReply);
      if (!host) done(new Error('This worker has no shared surface'));
      else host.setEffects(message.params, message.shader).then(() => done(), done);
      return;
    }
    case 'surface-effect-mouse':
      host?.setEffectMouse(message.mouse);
      return;
  }
  dedicated ??= createSession(scope, () => scope.close());
  dedicated(message);
};
