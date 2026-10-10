import { KEY_CODES } from './keycodes.js';
import {
  BackpressureError,
  packColor,
  percentile,
  type WraithOptions,
  type WraithStats,
  type WraithTheme,
  type Disposable,
  type BenchmarkOptions,
  type BenchmarkResult,
} from './types.js';
import type { Command, Reply } from './protocol.js';
export * from './types.js';
type Listener<T> = (value: T) => void;
class Signal<T> {
  private listeners = new Set<Listener<T>>();
  on(listener: Listener<T>): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  emit(value: T) {
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch (error) {
        console.error('Wraith event listener', error);
      }
    }
  }
  clear() {
    this.listeners.clear();
  }
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  bytes: number;
}
async function loadFont(value: string | URL | Uint8Array): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value.slice();
  const response = await fetch(value);
  if (!response.ok) throw new Error(`Font request failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
function mods(event: KeyboardEvent | MouseEvent): number {
  return (
    Number(event.shiftKey) |
    (Number(event.ctrlKey) << 1) |
    (Number(event.altKey) << 2) |
    (Number(event.metaKey) << 3)
  );
}
function validateGrid(cols: number, rows: number) {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 512 ||
    rows > 512 ||
    cols * rows > 65536
  )
    throw new RangeError('Grid must be 1..512 per dimension and at most 65,536 cells');
}

/** One independent worker, Wasm instance, and GPU device per terminal. */
export class Wraith {
  readonly element: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  readonly ready: Promise<void>;
  cols: number;
  rows: number;
  private worker: Worker;
  private options: WraithOptions;
  private dpr: number;
  private cellWidth = 9;
  private cellHeight = 18;
  private pending = new Map<number, Pending>();
  private sequence = 1;
  private pendingBytes = 0;
  private queue: { id: number; bytes: Uint8Array }[] = [];
  private flushScheduled = false;
  private observer?: ResizeObserver;
  private abort = new AbortController();
  private disposed = false;
  private failed = false;
  private data = new Signal<string>();
  private binary = new Signal<Uint8Array>();
  private title = new Signal<string>();
  private bell = new Signal<void>();
  private errors = new Signal<Error>();
  private statistics = new Signal<WraithStats>();
  private resizes = new Signal<{ cols: number; rows: number }>();
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private mouseTracking = false;
  private dragging = false;
  private selected = false;
  private anchor: [number, number] = [0, 0];
  private composing = false;
  private mirror?: HTMLPreElement;
  private mirrorTimer?: ReturnType<typeof setInterval>;
  private preedit: HTMLSpanElement;
  private theme: Required<WraithTheme>;
  private constructor(host: HTMLElement, options: WraithOptions) {
    this.options = options;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    validateGrid(this.cols, this.rows);
    this.theme = {
      foreground: '#dee5e8',
      background: '#0e1217',
      cursor: '#91d6f0',
      ...options.theme,
    };
    for (const color of Object.values(this.theme)) packColor(color);
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Prevent an unhandled rejection if font loading fails before mount awaits ready.
    void this.ready.catch(() => {});
    this.element = document.createElement('div');
    this.element.className = 'wraith-terminal';
    Object.assign(this.element.style, {
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      background: this.theme.background,
    });
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Wraith terminal');
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, { display: 'block', touchAction: 'none', userSelect: 'none' });
    this.input = document.createElement('textarea');
    this.input.setAttribute('aria-label', 'Terminal input');
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('autocomplete', 'off');
    this.input.spellcheck = false;
    Object.assign(this.input.style, {
      position: 'absolute',
      left: '0',
      bottom: '0',
      width: '1px',
      height: '1em',
      opacity: '0.01',
      padding: '0',
      border: '0',
      resize: 'none',
    });
    this.preedit = document.createElement('span');
    Object.assign(this.preedit.style, {
      position: 'absolute',
      left: '0',
      bottom: '0',
      background: this.theme.background,
      color: this.theme.foreground,
      pointerEvents: 'none',
      fontFamily: 'monospace',
    });
    this.element.append(this.canvas, this.input, this.preedit);
    host.append(this.element);
    this.worker = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
      name: 'Wraith terminal',
    });
    this.worker.onmessage = (event: MessageEvent<Reply>) => this.receive(event.data);
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'Wraith worker failed'));
    this.worker.onmessageerror = () =>
      this.fail(new Error('Wraith worker message could not be decoded'));
    this.bindInput();
  }
  static async mount(host: HTMLElement, options: WraithOptions = {}): Promise<Wraith> {
    if (!navigator.gpu)
      throw new Error('Wraith requires WebGPU in a secure context (HTTPS or localhost).');
    if (!HTMLCanvasElement.prototype.transferControlToOffscreen)
      throw new Error('Wraith requires OffscreenCanvas support.');
    const terminal = new Wraith(host, options);
    try {
      const [font, ...fonts] = await Promise.all(
        [
          options.font ?? new URL('../wasm/JetBrainsMono-Regular.ttf', import.meta.url),
          ...(options.fallbackFonts ?? []),
        ].map(loadFont),
      );
      const canvas = terminal.canvas.transferControlToOffscreen();
      terminal.send(
        {
          type: 'init',
          canvas,
          font: font!,
          fonts,
          cols: terminal.cols,
          rows: terminal.rows,
          size: (options.fontSize ?? 14) * terminal.dpr,
          lineHeight: options.lineHeight ?? 1.35,
          history: options.scrollback ?? 10000,
          theme: Object.values(terminal.theme).map(packColor),
        },
        [canvas, ...[font!, ...fonts].map((f) => f.buffer as ArrayBuffer)],
      );
      await terminal.ready;
      terminal.dimensions();
      if (options.fit !== false) {
        terminal.observer = new ResizeObserver(() => terminal.fit());
        terminal.observer.observe(host);
        terminal.fit();
      }
      if (options.screenReaderMode) terminal.enableMirror();
      return terminal;
    } catch (error) {
      terminal.fail(error instanceof Error ? error : new Error(String(error)));
      await terminal.dispose();
      throw error;
    }
  }
  private send(command: Command, transfer: Transferable[] = []) {
    this.worker.postMessage(command, transfer);
  }
  private assertLive() {
    if (this.disposed || this.failed)
      throw new Error('Wraith terminal has been disposed or failed');
  }
  private request<T>(command: Omit<Extract<Command, { id: number }>, 'id'>, bytes = 0): Promise<T> {
    this.assertLive();
    const id = this.sequence++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, bytes });
      this.send({ ...command, id } as Command);
    });
  }
  private receive(reply: Reply) {
    switch (reply.type) {
      case 'ready':
        this.cellWidth = reply.width;
        this.cellHeight = reply.height;
        this.readyResolve();
        break;
      case 'result': {
        const pending = this.pending.get(reply.id);
        if (pending) {
          this.pending.delete(reply.id);
          this.pendingBytes -= pending.bytes;
          if (reply.error) pending.reject(new Error(reply.error));
          else pending.resolve(reply.value);
        }
        break;
      }
      case 'data':
        this.binary.emit(reply.bytes);
        this.data.emit(this.decoder.decode(reply.bytes, { stream: true }));
        break;
      case 'title':
        this.title.emit(reply.title);
        break;
      case 'bell':
        this.bell.emit();
        break;
      case 'modes':
        this.mouseTracking = reply.mouse;
        break;
      case 'cursor': {
        const left = `${(reply.x * this.cellWidth) / this.dpr}px`,
          top = `${(reply.y * this.cellHeight) / this.dpr}px`;
        Object.assign(this.input.style, { left, top, bottom: 'auto' });
        Object.assign(this.preedit.style, { left, top, bottom: 'auto' });
        break;
      }
      case 'error':
        this.fail(new Error(reply.error));
        break;
      case 'stats': {
        const v = reply.values;
        this.statistics.emit({
          frames: v[0]!,
          inputBytes: v[1]!,
          parseMs: v[2]!,
          renderMs: v[3]!,
          uploadBytes: v[4]!,
          atlasGlyphs: v[5]!,
          atlasHits: v[6]!,
          atlasMisses: v[7]!,
          atlasResets: v[8]!,
          renderP50Ms: percentile(reply.samples, 0.5),
          renderP95Ms: percentile(reply.samples, 0.95),
          renderP99Ms: percentile(reply.samples, 0.99),
          activeFps: reply.fps,
          adapter: reply.adapter,
        });
        break;
      }
    }
  }
  private fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    this.readyReject(error);
    this.errors.emit(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.pendingBytes = 0;
    this.queue = [];
    this.observer?.disconnect();
    clearInterval(this.mirrorTimer);
    this.worker.terminate();
  }
  /** Resolves after bytes have been parsed. Use flush() to wait for rendering. */
  write(data: string | Uint8Array): Promise<void> {
    this.assertLive();
    const encoded = typeof data === 'string' ? this.encoder.encode(data) : data;
    if (this.pendingBytes + encoded.byteLength > (this.options.maxPendingBytes ?? 8 * 1024 * 1024))
      return Promise.reject(new BackpressureError());
    // Own the transferred copy; callers retain their original buffer.
    const bytes = typeof data === 'string' ? encoded : encoded.slice();
    const id = this.sequence++;
    this.pendingBytes += bytes.byteLength;
    const done = new Promise<void>((resolve, reject) =>
      this.pending.set(id, { resolve: () => resolve(), reject, bytes: bytes.byteLength }),
    );
    this.queue.push({ id, bytes });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushWrites());
    }
    return done;
  }
  private flushWrites() {
    this.flushScheduled = false;
    if (this.disposed || this.failed) return;
    // Separate acknowledgements preserve the ordering contract. Each write
    // crosses the worker boundary once; rendering coalesces at the next frame.
    for (const { id, bytes } of this.queue)
      this.send({ type: 'write', id, bytes }, [bytes.buffer as ArrayBuffer]);
    this.queue = [];
  }
  async flush(): Promise<void> {
    this.flushWrites();
    await this.request<void>({ type: 'flush' });
  }
  async resize(cols: number, rows: number): Promise<void> {
    validateGrid(cols, rows);
    if (cols === this.cols && rows === this.rows) return;
    await this.request<void>({ type: 'resize', cols, rows } as Omit<
      Extract<Command, { type: 'resize' }>,
      'id'
    >);
    this.cols = cols;
    this.rows = rows;
    this.dimensions();
    this.resizes.emit({ cols, rows });
  }
  fit(): void {
    if (this.disposed || this.failed) return;
    const rect = this.element.getBoundingClientRect();
    const cols = Math.min(512, Math.max(1, Math.floor((rect.width * this.dpr) / this.cellWidth)));
    const rows = Math.min(
      512,
      Math.floor(65536 / cols),
      Math.max(1, Math.floor((rect.height * this.dpr) / this.cellHeight)),
    );
    if (rect.width > 0 && rect.height > 0)
      void this.resize(cols, rows).catch((error) => this.errors.emit(error));
  }
  private dimensions() {
    this.canvas.style.width = `${(this.cols * this.cellWidth) / this.dpr}px`;
    this.canvas.style.height = `${(this.rows * this.cellHeight) / this.dpr}px`;
  }
  focus(): void {
    this.input.focus({ preventScroll: true });
  }
  onData(listener: Listener<string>): Disposable {
    return this.data.on(listener);
  }
  /** Byte-accurate output, including legacy binary mouse protocols. */
  onBytes(listener: Listener<Uint8Array>): Disposable {
    return this.binary.on(listener);
  }
  onTitleChange(listener: Listener<string>): Disposable {
    return this.title.on(listener);
  }
  onBell(listener: Listener<void>): Disposable {
    return this.bell.on(listener);
  }
  onError(listener: Listener<Error>): Disposable {
    return this.errors.on(listener);
  }
  onStats(listener: Listener<WraithStats>): Disposable {
    return this.statistics.on(listener);
  }
  onResize(listener: Listener<{ cols: number; rows: number }>): Disposable {
    return this.resizes.on(listener);
  }
  async paste(text: string): Promise<void> {
    await this.request<void>({ type: 'paste', text } as Omit<
      Extract<Command, { type: 'paste' }>,
      'id'
    >);
  }
  scroll(lines: number): void {
    this.assertLive();
    this.send({ type: 'scroll', delta: Math.trunc(lines) });
  }
  async getText(selected = false): Promise<string> {
    this.flushWrites();
    return this.request<string>({ type: 'text', selected } as Omit<
      Extract<Command, { type: 'text' }>,
      'id'
    >);
  }
  async benchmark(options: BenchmarkOptions = {}): Promise<BenchmarkResult> {
    this.flushWrites();
    return this.request<BenchmarkResult>({ type: 'benchmark', options } as Omit<
      Extract<Command, { type: 'benchmark' }>,
      'id'
    >);
  }
  setTheme(theme: WraithTheme): void {
    this.assertLive();
    const next = { ...this.theme, ...theme };
    const colors = Object.values(next).map(packColor);
    this.theme = next;
    this.element.style.background = next.background;
    this.send({ type: 'theme', colors });
  }
  connect(socket: WebSocket): Disposable {
    let incoming = Promise.resolve();
    const receive = (event: MessageEvent) => {
      incoming = incoming
        .then(async () => {
          const bytes =
            event.data instanceof Blob
              ? new Uint8Array(await event.data.arrayBuffer())
              : event.data instanceof ArrayBuffer
                ? new Uint8Array(event.data)
                : String(event.data);
          await this.write(bytes);
        })
        .catch((error) => this.errors.emit(error));
    };
    const output = this.onBytes((bytes) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
    });
    socket.addEventListener('message', receive);
    return {
      dispose: () => {
        output.dispose();
        socket.removeEventListener('message', receive);
      },
    };
  }
  private bindInput() {
    const options = { signal: this.abort.signal };
    this.input.addEventListener(
      'keydown',
      (event) => {
        if (this.composing || event.isComposing || event.key === 'Process' || event.key === 'Dead')
          return;
        if (
          (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
          event.key.toLowerCase() === 'c'
        ) {
          event.preventDefault();
          void this.getText(true)
            .then((text) => navigator.clipboard.writeText(text))
            .catch((error) => this.errors.emit(error));
          return;
        }
        if ((event.metaKey || (event.ctrlKey && event.shiftKey)) && event.key.toLowerCase() === 'v')
          return;
        if (event.metaKey) return; // Keep browser and OS shortcuts available.
        event.preventDefault();
        const character = [...event.key].length === 1 ? event.key : '';
        const unshifted = event.code.startsWith('Key')
          ? (event.code.slice(3).toLowerCase().codePointAt(0) ?? 0)
          : event.code.startsWith('Digit')
            ? (event.code.slice(5).codePointAt(0) ?? 0)
            : (character.toLowerCase().codePointAt(0) ?? 0);
        this.send({
          type: 'key',
          key: KEY_CODES[event.code] ?? 0,
          mods: mods(event),
          action: event.repeat ? 2 : 1,
          text: character,
          unshifted,
        });
        this.selected = false;
        this.send({ type: 'select', x1: -1, y1: 0, x2: 0, y2: 0 });
      },
      options,
    );
    this.input.addEventListener(
      'keyup',
      (event) => {
        if (event.isComposing || event.metaKey) return;
        this.send({
          type: 'key',
          key: KEY_CODES[event.code] ?? 0,
          mods: mods(event),
          action: 0,
          text: '',
          unshifted: 0,
        });
      },
      options,
    );
    this.input.addEventListener(
      'compositionstart',
      () => {
        this.composing = true;
      },
      options,
    );
    this.input.addEventListener(
      'compositionupdate',
      (event) => {
        this.preedit.textContent = event.data;
      },
      options,
    );
    this.input.addEventListener(
      'compositionend',
      (event) => {
        this.composing = false;
        this.preedit.textContent = '';
        if (event.data)
          this.send({ type: 'key', key: 0, mods: 0, action: 1, text: event.data, unshifted: 0 });
        this.input.value = '';
      },
      options,
    );
    this.input.addEventListener(
      'input',
      (event) => {
        const input = event as InputEvent;
        if (
          this.composing ||
          input.inputType === 'insertFromComposition' ||
          input.inputType === 'insertCompositionText'
        )
          return;
        if (input.data)
          this.send({ type: 'key', key: 0, mods: 0, action: 1, text: input.data, unshifted: 0 });
        this.input.value = '';
      },
      options,
    );
    this.input.addEventListener(
      'paste',
      (event) => {
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain');
        if (text) void this.paste(text).catch((error) => this.errors.emit(error));
      },
      options,
    );
    this.input.addEventListener(
      'focus',
      () => this.send({ type: 'focus', focused: true }),
      options,
    );
    this.input.addEventListener(
      'blur',
      () => this.send({ type: 'focus', focused: false }),
      options,
    );
    const point = (event: MouseEvent): [number, number] => {
      const rect = this.canvas.getBoundingClientRect();
      return [
        Math.max(
          0,
          Math.min(
            this.cols - 1,
            Math.floor(((event.clientX - rect.left) * this.dpr) / this.cellWidth),
          ),
        ),
        Math.max(
          0,
          Math.min(
            this.rows - 1,
            Math.floor(((event.clientY - rect.top) * this.dpr) / this.cellHeight),
          ),
        ),
      ];
    };
    const mouse = (event: PointerEvent, action: number) => {
      const rect = this.canvas.getBoundingClientRect();
      this.send({
        type: 'mouse',
        action,
        button: event.buttons === 0 && action === 2 ? 0 : ([1, 3, 2][event.button] ?? 0),
        mods: mods(event),
        x: Math.max(
          0,
          Math.min(this.cols * this.cellWidth - 1, (event.clientX - rect.left) * this.dpr),
        ),
        y: Math.max(
          0,
          Math.min(this.rows * this.cellHeight - 1, (event.clientY - rect.top) * this.dpr),
        ),
        pressed: event.buttons,
      });
    };
    this.canvas.addEventListener(
      'pointerdown',
      (event) => {
        this.focus();
        this.canvas.setPointerCapture(event.pointerId);
        if (this.mouseTracking && !event.shiftKey) {
          event.preventDefault();
          mouse(event, 0);
          return;
        }
        if (event.button !== 0) return;
        this.anchor = point(event);
        this.dragging = true;
        this.selected = true;
        this.send({
          type: 'select',
          x1: this.anchor[0],
          y1: this.anchor[1],
          x2: this.anchor[0],
          y2: this.anchor[1],
        });
      },
      options,
    );
    this.canvas.addEventListener(
      'pointermove',
      (event) => {
        if (this.mouseTracking && !event.shiftKey) {
          mouse(event, 2);
          return;
        }
        if (this.dragging) {
          const end = point(event);
          this.send({
            type: 'select',
            x1: this.anchor[0],
            y1: this.anchor[1],
            x2: end[0],
            y2: end[1],
          });
        }
      },
      options,
    );
    this.canvas.addEventListener(
      'pointerup',
      (event) => {
        this.dragging = false;
        if (this.mouseTracking && !event.shiftKey) mouse(event, 1);
      },
      options,
    );
    this.canvas.addEventListener(
      'pointercancel',
      () => {
        this.dragging = false;
      },
      options,
    );
    this.canvas.addEventListener(
      'click',
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        const [x, y] = point(event);
        void this.request<string>({ type: 'link', x, y } as Omit<
          Extract<Command, { type: 'link' }>,
          'id'
        >)
          .then((link) => {
            if (!link) return;
            const url = new URL(link);
            if (['https:', 'http:', 'mailto:'].includes(url.protocol))
              window.open(url.href, '_blank', 'noopener,noreferrer');
          })
          .catch((error) => this.errors.emit(error));
      },
      options,
    );
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        if (this.mouseTracking && !event.shiftKey) {
          const rect = this.canvas.getBoundingClientRect();
          this.send({
            type: 'mouse',
            action: 0,
            button: event.deltaY < 0 ? 4 : 5,
            mods: mods(event),
            x: Math.max(
              0,
              Math.min(this.cols * this.cellWidth - 1, (event.clientX - rect.left) * this.dpr),
            ),
            y: Math.max(
              0,
              Math.min(this.rows * this.cellHeight - 1, (event.clientY - rect.top) * this.dpr),
            ),
            pressed: 0,
          });
        } else
          this.scroll(
            Math.sign(event.deltaY) *
              Math.max(
                1,
                Math.round(
                  Math.abs(event.deltaY) / (event.deltaMode === 0 ? this.cellHeight / this.dpr : 1),
                ),
              ),
          );
      },
      { ...options, passive: false },
    );
    this.canvas.addEventListener(
      'contextmenu',
      (event) => {
        if (this.mouseTracking) event.preventDefault();
      },
      options,
    );
    document.addEventListener(
      'visibilitychange',
      () => this.send({ type: 'visibility', visible: !document.hidden }),
      options,
    );
  }
  private enableMirror() {
    this.mirror = document.createElement('pre');
    this.mirror.setAttribute('role', 'log');
    this.mirror.setAttribute('aria-live', 'polite');
    Object.assign(this.mirror.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
    });
    this.element.append(this.mirror);
    this.mirrorTimer = setInterval(() => {
      void this.getText()
        .then((text) => {
          if (this.mirror && this.mirror.textContent !== text) this.mirror.textContent = text;
        })
        .catch(() => {});
    }, 250);
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.observer?.disconnect();
    clearInterval(this.mirrorTimer);
    for (const pending of this.pending.values()) pending.reject(new Error('Wraith disposed'));
    this.pending.clear();
    this.queue = [];
    // Allow Ghostty and wgpu destructors to run; terminate a stalled worker after a bounded wait.
    if (!this.failed)
      await new Promise<void>((resolve) => {
        const id = this.sequence++;
        const finish = () => {
          this.worker.terminate();
          resolve();
        };
        const timer = setTimeout(finish, 1000);
        this.pending.set(id, {
          bytes: 0,
          reject: finish,
          resolve: () => {
            clearTimeout(timer);
            finish();
          },
        });
        this.send({ type: 'dispose', id });
      });
    this.element.remove();
    this.data.clear();
    this.binary.clear();
    this.title.clear();
    this.bell.clear();
    this.errors.clear();
    this.statistics.clear();
    this.resizes.clear();
  }
}
