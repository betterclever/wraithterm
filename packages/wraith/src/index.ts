import { dedicatedChannel, WraithPool, type Channel, type WraithPoolOptions } from './pool.js';
import { KEY_CODES } from './keycodes.js';
import { TerminalAccessibility } from './accessibility.js';
import {
  BackpressureError,
  packColor,
  type WraithOptions,
  type WraithStats,
  type WraithTheme,
  type Disposable,
  type BenchmarkOptions,
  type BenchmarkResult,
  type SearchResult,
  type SelectionPosition,
  type KeyEventHandler,
  type ReadTextOptions,
  type WraithAccessibilityOptions,
  type WraithConnectOptions,
  type WraithConnection,
  type WraithCloseEvent,
} from './types.js';
import type { Command, Reply } from './protocol.js';
import { CommandBlocks } from './command-blocks.js';
import type { CommandBlock } from './command-types.js';
import { EffectsController, type WraithEffects } from './effects.js';
export * from './types.js';
export * from './command-types.js';
export { parseOsc133, type Osc133Step } from './osc133.js';
export type {
  WraithEffects,
  WraithCrtOptions,
  WraithBloomOptions,
  WraithCursorTrailOptions,
} from './effects.js';
type Listener<T> = (value: T) => void;
class Signal<T> {
  private listeners = new Set<Listener<T>>();
  get size() {
    return this.listeners.size;
  }
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
class WorkerConnection implements WraithConnection {
  readonly opened: Promise<void>;
  readonly closed: Promise<WraithCloseEvent>;
  transport: 'stream' | 'events' | undefined;
  private opens = new Signal<void>();
  private closes = new Signal<WraithCloseEvent>();
  private errors = new Signal<Error>();
  private resolveOpen!: () => void;
  private rejectOpen!: (error: Error) => void;
  private resolveClose!: (event: WraithCloseEvent) => void;
  private done = false;
  constructor(
    readonly link: number,
    private post: (command: Command, transfer?: Transferable[]) => void,
    private release: () => void,
  ) {
    this.opened = new Promise((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    void this.opened.catch(() => {});
    this.closed = new Promise((resolve) => (this.resolveClose = resolve));
  }
  send(data: string | Uint8Array) {
    if (this.done) return;
    if (typeof data === 'string') this.post({ type: 'socket-send', link: this.link, data });
    else {
      const bytes = data.slice();
      this.post({ type: 'socket-send', link: this.link, data: bytes }, [bytes.buffer]);
    }
  }
  close(code?: number, reason?: string) {
    if (!this.done) this.post({ type: 'socket-close', link: this.link, code, reason });
  }
  onOpen(listener: () => void): Disposable {
    return this.opens.on(listener);
  }
  onClose(listener: (event: WraithCloseEvent) => void): Disposable {
    return this.closes.on(listener);
  }
  onError(listener: (error: Error) => void): Disposable {
    return this.errors.on(listener);
  }
  dispose() {
    this.close(1000);
    this.opens.clear();
    this.closes.clear();
    this.errors.clear();
  }
  /** @internal */
  event(reply: Extract<Reply, { type: 'socket' }>) {
    if (this.done) return;
    if (reply.event === 'open') {
      this.transport = reply.transport;
      this.resolveOpen();
      this.opens.emit();
    } else if (reply.event === 'error')
      this.errors.emit(new Error(reply.error ?? 'WebSocket error'));
    else
      this.finish({
        code: reply.code ?? 1006,
        reason: reply.reason ?? '',
        wasClean: !!reply.wasClean,
      });
  }
  /** @internal */
  finish(event: WraithCloseEvent) {
    if (this.done) return;
    this.done = true;
    this.release();
    this.rejectOpen(new Error(`WebSocket closed before opening (${event.code})`));
    this.resolveClose(event);
    this.closes.emit(event);
    this.opens.clear();
    this.closes.clear();
    this.errors.clear();
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
export {
  WraithPool,
  type WraithPoolOptions,
  type PlacementTracking,
  type SharedSurfaceOptions,
  type SharedSurfaceStats,
} from './pool.js';
export class Wraith {
  /** A pool of shared workers for mounting many terminals; pass it as `pool`. */
  static pool(options?: WraithPoolOptions): WraithPool {
    return new WraithPool(options);
  }
  readonly element: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  readonly ready: Promise<void>;
  cols: number;
  rows: number;
  private worker: Channel;
  private options: WraithOptions;
  private dpr: number;
  private fontBytes?: Uint8Array;
  private fallbackBytes: Uint8Array[] = [];
  private displayUpdates = Promise.resolve();
  private dprQuery?: MediaQueryList;
  private dprListener?: () => void;
  private cellWidth = 9;
  private cellHeight = 18;
  private pending = new Map<number, Pending>();
  private sequence = 1;
  private pendingBytes = 0;
  private links = new Map<number, WorkerConnection>();
  /** Writes queued this task, encoded or copied once into one buffer that
   * crosses to the worker as a single transfer with one acknowledgement. */
  private batch = new Uint8Array(0);
  private batchLength = 0;
  private batchIds: number[] = [];
  private flushScheduled = false;
  private observer?: ResizeObserver;
  private visibilityObserver?: IntersectionObserver;
  private visibilityReady = false;
  private intersectsViewport = true;
  private workerVisible = true;
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
  private renders = new Signal<{ frame: number }>();
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private mouseTracking = false;
  private dragging = false;
  private selected = false;
  private anchor: [number, number] = [0, 0];
  private selectionMode = 0;
  private clickCount = 0;
  private lastClick = -Infinity;
  private clickPoint: [number, number] = [-1, -1];
  private keyHandlers = new Set<KeyEventHandler>();
  private interceptedKeys = new Set<string>();
  private composing = false;
  private preedit: HTMLSpanElement;
  private theme: Required<WraithTheme>;
  /** System colors while forced-colors mode is active; overrides `theme`. */
  private forcedTheme?: Required<WraithTheme>;
  private started = false;
  private hostPaused: boolean;
  private a11y: TerminalAccessibility;
  private announcements = new Signal<string>();
  private blocks: CommandBlocks;
  /** CSS pixels reserved left of the canvas for the command gutter. */
  private inset = 0;
  private effectsController: EffectsController;
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
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, { display: 'block', touchAction: 'none', userSelect: 'none' });
    this.input = document.createElement('textarea');
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
      // Shown only while an IME composes: a positioned, z-indexed span above a
      // shared surface would otherwise be its own compositor layer per terminal.
      display: 'none',
    });
    this.element.append(this.canvas, this.input, this.preedit);
    host.append(this.element);
    this.hostPaused = !!options.paused;
    this.a11y = new TerminalAccessibility(
      {
        host,
        element: this.element,
        input: this.input,
        signal: this.abort.signal,
        send: (command) => {
          // The worker rejects session commands before init, failing the mount.
          if (!this.started || this.disposed || this.failed) return false;
          this.send(command);
          return true;
        },
        geometry: () => ({
          rowHeight: this.cellHeight / this.dpr,
          width: (this.cols * this.cellWidth) / this.dpr,
        }),
        setForcedTheme: (theme) => {
          this.forcedTheme = theme;
          this.applyTheme();
        },
        announced: (text) => this.announcements.emit(text),
      },
      options.accessibility,
    );
    const handlers = {
      message: (reply: Reply) => this.receive(reply),
      fail: (error: Error) => this.fail(error),
    };
    this.worker = options.pool ? options.pool.connect(handlers) : dedicatedChannel(handlers);
    // IME composition text must stay visible above a shared surface.
    if (this.worker.surface) this.preedit.style.zIndex = String(this.worker.surface.zIndex + 1);
    this.bindInput();
    this.blocks = new CommandBlocks(
      {
        element: this.element,
        canvas: this.canvas,
        geometry: () => ({
          cellWidth: this.cellWidth,
          cellHeight: this.cellHeight,
          dpr: this.dpr,
          cols: this.cols,
          rows: this.rows,
        }),
        request: <T>(command: Record<string, unknown> & { type: string }) =>
          this.request<T>(command as unknown as Omit<Extract<Command, { id: number }>, 'id'>),
        addKeyHandler: (handler) => this.attachCustomKeyEventHandler(handler),
        reserve: (pixels) => {
          // Only a fitted terminal can give up width without clipping columns.
          if (this.options.fit === false || this.inset) return false;
          this.inset = pixels;
          Object.assign(this.element.style, {
            boxSizing: 'border-box',
            paddingLeft: `${pixels}px`,
          });
          this.fit();
          return true;
        },
        error: (error) =>
          this.errors.emit(error instanceof Error ? error : new Error(String(error))),
      },
      options.commandBlocks,
    );
    this.effectsController = new EffectsController(
      this.canvas,
      () => this.dpr,
      ({ params, shader }) =>
        this.request<void>({ type: 'effects', params, shader } as Omit<
          Extract<Command, { type: 'effects' }>,
          'id'
        >),
      (mouse) => {
        if (!this.disposed && !this.failed) this.send({ type: 'effect-mouse', mouse });
      },
      (error) => this.errors.emit(error),
    );
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
      // A shared-surface pool draws into its own canvas; this one stays a
      // placeholder for layout, pointer input and visibility.
      const canvas = terminal.worker.surface
        ? undefined
        : terminal.canvas.transferControlToOffscreen();
      terminal.fontBytes = font!.slice();
      terminal.fallbackBytes = fonts.map((bytes) => bytes.slice());
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
          imageStorageLimit: options.imageStorageLimit,
          ligatures: options.ligatures,
          theme: Object.values(terminal.forcedTheme ?? terminal.theme).map(packColor),
        },
        [...(canvas ? [canvas] : []), ...[font!, ...fonts].map((f) => f.buffer as ArrayBuffer)],
      );
      terminal.started = true;
      await terminal.ready;
      terminal.dimensions();
      terminal.worker.surface?.track(terminal.canvas, terminal.element);
      terminal.watchVisibility();
      if (options.fit !== false) {
        terminal.observer = new ResizeObserver(() => terminal.fit());
        terminal.observer.observe(host);
        terminal.fit();
      }
      terminal.a11y.setScreenReaderMode(!!options.screenReaderMode);
      terminal.a11y.configure();
      if (options.effects)
        // An invalid custom shader must not fail the mount: report it once the
        // caller can subscribe, and keep rendering without effects.
        await terminal.effectsController
          .set(options.effects)
          .catch((error) => setTimeout(() => terminal.errors.emit(error), 0));
      terminal.watchDisplay();
      window.addEventListener('resize', () => terminal.checkDisplay(), {
        signal: terminal.abort.signal,
      });
      return terminal;
    } catch (error) {
      terminal.fail(error instanceof Error ? error : new Error(String(error)));
      await terminal.dispose();
      throw error;
    }
  }
  private send(command: Command, transfer: Transferable[] = []) {
    if (command.type !== 'write') this.flushWrites();
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
      case 'written':
        for (const id of reply.ids) {
          const pending = this.pending.get(id);
          if (!pending) continue;
          this.pending.delete(id);
          this.pendingBytes -= pending.bytes;
          if (reply.error) pending.reject(new Error(reply.error));
          else pending.resolve(undefined);
        }
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
      case 'cursor':
        this.cursorCell = [reply.x, reply.y];
        // Only the focused terminal's IME anchor follows the cursor. Moving
        // every unfocused input makes the browser re-layerize the page each
        // frame, which dominates with hundreds of terminals.
        if (this.composing || document.activeElement === this.input) this.placeInput();
        break;
      case 'render':
        this.renders.emit({ frame: reply.frame });
        break;
      case 'a11y':
        this.a11y.receive(reply);
        break;
      case 'error':
        this.fail(new Error(reply.error));
        break;
      case 'command':
      case 'marks':
        // Replies can still arrive while dispose() waits for the worker.
        if (!this.disposed && !this.failed) this.blocks.receive(reply);
        break;
      case 'socket':
        this.links.get(reply.link)?.event(reply);
        break;
      case 'stats': {
        // Some browser/display transitions update resolution without delivering
        // a media-query change event. Reuse the existing stats heartbeat.
        this.checkDisplay();
        if (!this.statistics.size) break;
        // Sort the render samples once for all three percentiles.
        const sorted = Float64Array.from(reply.samples).sort();
        const at = (fraction: number) =>
          sorted.length
            ? sorted[
                Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
              ]!
            : 0;
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
          renderP50Ms: at(0.5),
          renderP95Ms: at(0.95),
          renderP99Ms: at(0.99),
          activeFps: reply.fps,
          adapter: reply.adapter,
          effectPasses: reply.effectPasses,
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
    this.batchIds = [];
    this.batchLength = 0;
    this.endLinks(error.message);
    this.observer?.disconnect();
    this.visibilityObserver?.disconnect();
    this.dprQuery?.removeEventListener('change', this.dprListener!);
    this.fontBytes = undefined;
    this.fallbackBytes = [];
    this.effectsController.dispose();
    this.worker.terminate();
  }
  /** Resolves after bytes have been parsed. Use flush() to wait for rendering. */
  write(data: string | Uint8Array): Promise<void> {
    this.assertLive();
    const limit = this.options.maxPendingBytes ?? 8 * 1024 * 1024;
    // Strings encode straight into the batch; byte arrays are copied once,
    // so callers retain ownership of their original buffer.
    let length: number;
    if (typeof data === 'string') {
      if (this.pendingBytes + data.length > limit) return Promise.reject(new BackpressureError());
      this.reserve(data.length * 3);
      length = this.encoder.encodeInto(data, this.batch.subarray(this.batchLength)).written;
    } else length = data.byteLength;
    if (this.pendingBytes + length > limit) return Promise.reject(new BackpressureError());
    if (typeof data !== 'string') {
      this.reserve(length);
      this.batch.set(data, this.batchLength);
    }
    this.batchLength += length;
    const id = this.sequence++;
    this.pendingBytes += length;
    const done = new Promise<void>((resolve, reject) =>
      this.pending.set(id, { resolve: () => resolve(), reject, bytes: length }),
    );
    this.batchIds.push(id);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushWrites());
    }
    return done;
  }
  private reserve(bytes: number) {
    if (this.batchLength + bytes <= this.batch.length) return;
    // The batch buffer is transferred on every flush, so most writes start a
    // new one: size the first to the write, grow later ones geometrically.
    const next = new Uint8Array(
      this.batchLength ? Math.max(1024, (this.batchLength + bytes) * 2) : Math.max(64, bytes),
    );
    next.set(this.batch.subarray(0, this.batchLength));
    this.batch = next;
  }
  private flushWrites() {
    this.flushScheduled = false;
    if (this.disposed || this.failed || !this.batchIds.length) return;
    // Writes keep their order and each promise still resolves after its bytes
    // are parsed; a burst crosses the worker boundary once.
    const bytes = this.batch.subarray(0, this.batchLength);
    this.send({ type: 'write', ids: this.batchIds, bytes }, [bytes.buffer as ArrayBuffer]);
    this.batch = new Uint8Array(0);
    this.batchLength = 0;
    this.batchIds = [];
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
    const width = rect.width - this.inset;
    const cols = Math.min(512, Math.max(1, Math.floor((width * this.dpr) / this.cellWidth)));
    const rows = Math.min(
      512,
      Math.floor(65536 / cols),
      Math.max(1, Math.floor((rect.height * this.dpr) / this.cellHeight)),
    );
    if (rect.width > 0 && rect.height > 0)
      void this.resize(cols, rows).catch((error) => this.errors.emit(error));
  }
  private cursorCell?: [number, number];
  private placeInput() {
    if (!this.cursorCell) return;
    // Offset by the command gutter reserved left of the canvas.
    const left = `${this.inset + (this.cursorCell[0] * this.cellWidth) / this.dpr}px`,
      top = `${(this.cursorCell[1] * this.cellHeight) / this.dpr}px`;
    Object.assign(this.input.style, { left, top, bottom: 'auto' });
    Object.assign(this.preedit.style, { left, top, bottom: 'auto' });
  }
  private dimensions() {
    if (this.worker.surface) {
      // The placeholder's size in terminal pixels gives the shared surface its scale.
      this.canvas.width = this.cols * this.cellWidth;
      this.canvas.height = this.rows * this.cellHeight;
    }
    this.blocks.draw();
    this.canvas.style.width = `${(this.cols * this.cellWidth) / this.dpr}px`;
    this.canvas.style.height = `${(this.rows * this.cellHeight) / this.dpr}px`;
    this.preedit.style.fontSize = `${this.options.fontSize ?? 14}px`;
    this.a11y.layout();
  }
  /** Change CSS text size without replacing terminal state or the worker. */
  setFontSize(fontSize: number): Promise<void> {
    return this.configureDisplay({ fontSize });
  }
  /** Replace supplied OpenType fonts and optionally the text geometry atomically. */
  setFont(
    font: string | URL | Uint8Array,
    options: Pick<WraithOptions, 'fontSize' | 'lineHeight' | 'fallbackFonts'> = {},
  ): Promise<void> {
    return this.configureDisplay({ ...options, font });
  }
  private configureDisplay(
    changes: Pick<WraithOptions, 'fontSize' | 'lineHeight' | 'font' | 'fallbackFonts'>,
  ): Promise<void> {
    this.assertLive();
    const update = this.displayUpdates.then(async () => {
      this.assertLive();
      const next = { ...this.options, ...changes };
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const size = (next.fontSize ?? 14) * dpr;
      const lineHeight = next.lineHeight ?? 1.35;
      if (
        !Number.isFinite(size) ||
        size < 6 ||
        size > 96 ||
        !Number.isFinite(lineHeight) ||
        lineHeight < 1 ||
        lineHeight > 2
      )
        throw new RangeError(
          'Font size must be 6..96 physical pixels and line height must be 1..2',
        );
      const font = changes.font !== undefined ? await loadFont(changes.font) : this.fontBytes!;
      const fonts =
        changes.fallbackFonts !== undefined
          ? await Promise.all(changes.fallbackFonts.map(loadFont))
          : this.fallbackBytes;
      this.assertLive();
      const dimensions = await this.request<number[]>({
        type: 'font',
        font,
        fonts,
        size,
        lineHeight,
      } as Omit<Extract<Command, { type: 'font' }>, 'id'>);
      this.options = next;
      this.fontBytes = font;
      this.fallbackBytes = fonts;
      this.dpr = dpr;
      [this.cellWidth, this.cellHeight] = dimensions as [number, number];
      this.dimensions();
      if (this.options.fit !== false) this.fit();
    });
    // A rejected font must not poison later display changes.
    this.displayUpdates = update.catch(() => {});
    return update;
  }
  private watchDisplay() {
    this.dprQuery?.removeEventListener('change', this.dprListener!);
    if (this.disposed || this.failed) return;
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprListener = () => {
      this.watchDisplay();
      if (Math.min(3, window.devicePixelRatio || 1) !== this.dpr)
        void this.configureDisplay({}).catch((error) => this.errors.emit(error));
    };
    this.dprQuery.addEventListener('change', this.dprListener, { once: true });
  }
  private checkDisplay() {
    if (this.disposed || this.failed) return;
    if (this.dprQuery && !this.dprQuery.matches) this.dprListener?.();
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
  /** Render submission notification, not a GPU fence or proof of display presentation.
   * Worker notifications are enabled only while at least one listener exists. */
  onRender(listener: Listener<{ frame: number }>): Disposable {
    this.assertLive();
    const subscription = this.renders.on((value) => listener(value));
    if (this.renders.size === 1) this.send({ type: 'observe-render', enabled: true });
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        subscription.dispose();
        if (!this.renders.size && !this.disposed && !this.failed)
          this.send({ type: 'observe-render', enabled: false });
      },
    };
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
  /** Search toward older matches, wrapping through retained scrollback. */
  findNext(needle: string): Promise<SearchResult> {
    return this.find(needle, 1);
  }
  /** Search toward newer matches, wrapping through retained scrollback. */
  findPrevious(needle: string): Promise<SearchResult> {
    return this.find(needle, -1);
  }
  private find(needle: string, direction: number): Promise<SearchResult> {
    if (typeof needle !== 'string' || this.encoder.encode(needle).byteLength > 4096)
      return Promise.reject(new RangeError('Search must be a string of at most 4096 UTF-8 bytes'));
    return this.request<SearchResult>({ type: 'search', needle, direction } as Omit<
      Extract<Command, { type: 'search' }>,
      'id'
    >);
  }
  async clearSearch(): Promise<void> {
    await this.find('', 1);
  }
  /** Select inclusive viewport cell endpoints. */
  select(start: SelectionPosition, end: SelectionPosition, rectangular = false): Promise<void> {
    return this.selection(start, end, rectangular ? 1 : 0);
  }
  selectWord(x: number, y: number): Promise<void> {
    return this.selection({ x, y }, { x, y }, 2);
  }
  selectLine(y: number): Promise<void> {
    return this.selection({ x: 0, y }, { x: 0, y }, 3);
  }
  selectAll(): Promise<void> {
    return this.selection({ x: 0, y: 0 }, { x: 0, y: 0 }, 4);
  }
  clearSelection(): Promise<void> {
    return this.selection({ x: -1, y: 0 }, { x: 0, y: 0 }, 0);
  }
  private async selection(
    start: SelectionPosition,
    end: SelectionPosition,
    mode: number,
  ): Promise<void> {
    for (const point of [start, end]) {
      if (
        !Number.isInteger(point.x) ||
        !Number.isInteger(point.y) ||
        point.x < (start.x === -1 && point === start ? -1 : 0) ||
        point.x >= this.cols ||
        point.y < 0 ||
        point.y >= this.rows
      )
        throw new RangeError('Selection must use valid viewport cell coordinates');
    }
    await this.request<void>({
      type: 'selection',
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      mode,
    } as Omit<Extract<Command, { type: 'selection' }>, 'id'>);
    this.selected = start.x !== -1;
  }
  /**
   * Shell commands recorded from OSC 133 semantic prompt marks, oldest first
   * (see SHELL_INTEGRATION). Output text is read lazily with `block.output()`.
   */
  commands(): Promise<CommandBlock[]> {
    this.flushWrites();
    return this.blocks.commands();
  }
  /** Fires when a command finishes (OSC 133;D, or the next prompt). */
  onCommand(listener: Listener<CommandBlock>): Disposable {
    return this.blocks.onCommand(listener);
  }
  /**
   * Scroll the previous (-1) or next (1) prompt to the top of the viewport.
   * Resolves false when there is none. Bound to Cmd+Up/Down on macOS and
   * Ctrl+Shift+Up/Down elsewhere once the first command has run.
   */
  jumpToPrompt(direction: -1 | 1): Promise<boolean> {
    this.flushWrites();
    return this.blocks.jumpToPrompt(direction);
  }
  /** Copy a command block's output to the clipboard and return it. */
  copyCommandOutput(id: number): Promise<string> {
    this.flushWrites();
    return this.blocks.copyCommandOutput(id);
  }
  /** Return false to keep a key event out of the terminal. Prevent its browser default in the handler if desired. */
  attachCustomKeyEventHandler(handler: KeyEventHandler): Disposable {
    this.assertLive();
    this.keyHandlers.add(handler);
    return { dispose: () => this.keyHandlers.delete(handler) };
  }
  async benchmark(options: BenchmarkOptions = {}): Promise<BenchmarkResult> {
    this.flushWrites();
    return this.request<BenchmarkResult>({ type: 'benchmark', options } as Omit<
      Extract<Command, { type: 'benchmark' }>,
      'id'
    >);
  }
  /** The effects currently applied, or null when none are enabled. */
  get effects(): WraithEffects | null {
    return this.effectsController.effects;
  }
  /**
   * Replace GPU post-process effects; pass `null` or `{}` to turn them off,
   * which removes every extra pass and texture. Rejects (and emits `onError`)
   * with the compiler's messages for an invalid custom shader, keeping the
   * previous effects; the terminal keeps running.
   */
  async setEffects(effects: WraithEffects | null): Promise<void> {
    this.assertLive();
    try {
      await this.effectsController.set(effects);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.failed && !this.disposed) this.errors.emit(failure);
      throw failure;
    }
  }
  setTheme(theme: WraithTheme): void {
    this.assertLive();
    const next = { ...this.theme, ...theme };
    Object.values(next).forEach(packColor);
    this.theme = next;
    this.applyTheme();
  }
  private applyTheme() {
    const theme = this.forcedTheme ?? this.theme;
    this.element.style.background = theme.background;
    this.preedit.style.background = theme.background;
    this.preedit.style.color = theme.foreground;
    // Before init the engine takes the effective theme with its other settings.
    if (this.started && !this.disposed && !this.failed)
      this.send({ type: 'theme', colors: Object.values(theme).map(packColor) });
  }
  /**
   * Plain text of the visible screen (default), or of retained scrollback plus
   * the screen with soft-wrapped lines joined (`scope: 'all'`). Reading `all`
   * clears an active selection. It never changes the viewport or focus.
   */
  async readText(options: ReadTextOptions = {}): Promise<string> {
    const scope = options.scope ?? 'screen';
    if (scope !== 'screen' && scope !== 'all') throw new RangeError('scope must be screen or all');
    this.flushWrites();
    const text = await this.request<string>({ type: 'read', scope } as Omit<
      Extract<Command, { type: 'read' }>,
      'id'
    >);
    if (scope === 'all') this.selected = false;
    const last = options.lastLines;
    if (last === undefined) return text;
    if (!Number.isInteger(last) || last < 0) throw new RangeError('lastLines must be a count');
    return last === 0 ? '' : text.split('\n').slice(-last).join('\n');
  }
  /** Stop painting (an inactive pane). Parsing, replies and accessibility
   * continue; `resume()` paints the latest state once, without replaying output. */
  pause(): void {
    this.hostPaused = true;
    this.updateVisibility();
  }
  resume(): void {
    this.hostPaused = false;
    this.updateVisibility();
  }
  /** Whether painting is paused by `pause()`. Offscreen and hidden-document
   * pausing is automatic and independent. */
  get paused(): boolean {
    return this.hostPaused;
  }
  get screenReaderMode(): boolean {
    return this.a11y.enabled;
  }
  /** Add or remove the accessible mirror and output announcements at runtime. */
  setScreenReaderMode(enabled: boolean): void {
    this.assertLive();
    this.a11y.setScreenReaderMode(enabled);
  }
  /** Change accessibility options without remounting. */
  setAccessibility(options: WraithAccessibilityOptions): void {
    this.assertLive();
    this.a11y.update(options);
  }
  /** Speak a host message (for example "Connection lost") through the
   * terminal's live region. Requires screen reader mode. */
  announce(text: string): void {
    this.a11y.announce(String(text));
  }
  /** Text placed in the live region: output summaries and `announce()` calls. */
  onAnnounce(listener: Listener<string>): Disposable {
    return this.announcements.on(listener);
  }
  private endLinks(reason: string) {
    for (const link of [...this.links.values()])
      link.finish({ code: 1006, reason, wasClean: false });
  }
  /**
   * Open a WebSocket in the terminal's worker (`ws:`, `wss:`, `http(s):` or a
   * path relative to the page). Output is parsed in the worker, never on the
   * main thread; input and terminal replies are sent from the worker in order.
   * Connecting again closes the previous worker socket.
   */
  connect(url: string | URL, options?: WraithConnectOptions): WraithConnection;
  /** Bridge a page-owned WebSocket: messages are received here and posted to the worker. */
  connect(socket: WebSocket): Disposable;
  connect(target: string | URL | WebSocket, options: WraithConnectOptions = {}): Disposable {
    if (typeof target === 'string' || target instanceof URL)
      return this.connectWorker(target, options);
    return this.bridge(target);
  }
  private connectWorker(target: string | URL, options: WraithConnectOptions): WraithConnection {
    this.assertLive();
    const url = new URL(target, location.href);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    const id = this.sequence++;
    const connection = new WorkerConnection(
      id,
      (command, transfer) => {
        if (!this.disposed && !this.failed) this.send(command, transfer);
      },
      () => this.links.delete(id),
    );
    this.links.set(id, connection);
    const protocols = options.protocols ?? [];
    this.send({
      type: 'socket-open',
      link: id,
      url: url.href,
      protocols: typeof protocols === 'string' ? [protocols] : [...protocols],
      stream: options.stream !== false,
    });
    return connection;
  }
  private bridge(socket: WebSocket): Disposable {
    // Messages are written in order and batched across the worker boundary.
    // Only when queued bytes pass half the backpressure limit does reading
    // wait, for the latest write (and so everything before it) to be parsed.
    const highWater = (this.options.maxPendingBytes ?? 8 * 1024 * 1024) / 2;
    let incoming = Promise.resolve(),
      latest: Promise<void> = Promise.resolve();
    const receive = (event: MessageEvent) => {
      incoming = incoming
        .then(async () => {
          const bytes =
            event.data instanceof Blob
              ? new Uint8Array(await event.data.arrayBuffer())
              : event.data instanceof ArrayBuffer
                ? new Uint8Array(event.data)
                : String(event.data);
          if (this.pendingBytes > highWater) await latest;
          latest = this.write(bytes);
          latest.catch((error) => this.errors.emit(error));
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
        this.interceptedKeys.delete(event.code);
        for (const handler of this.keyHandlers) {
          if (!handler(event)) {
            this.interceptedKeys.add(event.code);
            return;
          }
        }
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
        if (this.interceptedKeys.delete(event.code)) return;
        for (const handler of this.keyHandlers) if (!handler(event)) return;
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
        this.preedit.style.display = '';
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
        this.preedit.style.display = 'none';
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
        if (this.interceptedKeys.size && input.inputType === 'insertText') {
          this.input.value = '';
          return;
        }
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
      () => {
        this.placeInput();
        this.send({ type: 'focus', focused: true });
      },
      options,
    );
    this.input.addEventListener(
      'blur',
      () => {
        this.interceptedKeys.clear();
        this.send({ type: 'focus', focused: false });
      },
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
        const sameCell =
          this.anchor[0] === this.clickPoint[0] && this.anchor[1] === this.clickPoint[1];
        this.clickCount =
          sameCell && event.timeStamp - this.lastClick < 400 ? (this.clickCount % 3) + 1 : 1;
        this.lastClick = event.timeStamp;
        this.clickPoint = this.anchor;
        this.selectionMode = event.altKey
          ? 1
          : this.clickCount === 2
            ? 2
            : this.clickCount === 3
              ? 3
              : 0;
        this.dragging = true;
        this.selected = true;
        this.send({
          type: 'select',
          x1: this.anchor[0],
          y1: this.anchor[1],
          x2: this.anchor[0],
          y2: this.anchor[1],
          mode: this.selectionMode,
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
            mode: this.selectionMode,
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
    document.addEventListener('visibilitychange', () => this.updateVisibility(), options);
  }
  private watchVisibility() {
    // Font loading and engine creation are asynchronous. Never send a visibility
    // command before init: the worker serial queue requires a live engine.
    this.visibilityReady = true;
    if (typeof IntersectionObserver !== 'undefined') {
      try {
        this.visibilityObserver = new IntersectionObserver(
          (entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) return;
            this.intersectsViewport =
              entry.isIntersecting &&
              entry.intersectionRect.width > 0 &&
              entry.intersectionRect.height > 0;
            this.updateVisibility();
          },
          { threshold: [0, Number.EPSILON] },
        );
        this.visibilityObserver.observe(this.canvas);
      } catch {
        // Visibility is an optimization; document visibility remains available
        // in hosts without a working intersection observer.
        this.visibilityObserver?.disconnect();
        this.visibilityObserver = undefined;
      }
    }
    this.updateVisibility();
  }
  private updateVisibility() {
    if (!this.visibilityReady || this.disposed || this.failed) return;
    const visible = !this.hostPaused && !document.hidden && this.intersectsViewport;
    if (visible === this.workerVisible) return;
    this.workerVisible = visible;
    this.send({ type: 'visibility', visible });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.blocks.dispose();
    this.observer?.disconnect();
    this.visibilityObserver?.disconnect();
    this.dprQuery?.removeEventListener('change', this.dprListener!);
    this.fontBytes = undefined;
    this.fallbackBytes = [];
    this.a11y.dispose();
    this.effectsController.dispose();
    for (const pending of this.pending.values()) pending.reject(new Error('Wraith disposed'));
    this.pending.clear();
    this.endLinks('Wraith disposed');
    this.batchIds = [];
    this.batchLength = 0;
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
    this.renders.clear();
    this.announcements.clear();
    this.keyHandlers.clear();
    this.interceptedKeys.clear();
  }
}

export { Terminal } from './xterm.js';
export type * from './xterm-api.js';
