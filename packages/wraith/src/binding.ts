/**
 * Framework-agnostic lifecycle shared by `wraithterm/react`, `wraithterm/vue`,
 * `wraithterm/svelte` and `wraithterm/element`.
 *
 * The terminal runtime is loaded with dynamic `import()`, so importing a binding
 * never touches `window`, `navigator` or WebGPU (safe during SSR) and the engine
 * lands in its own chunk. Mounting is asynchronous; disposing before the mount
 * settles disposes the instance as soon as it exists, exactly once. That makes
 * React StrictMode's mount → cleanup → mount sequence leak-free.
 */
import type { Wraith } from './index.js';
import type { Terminal } from './xterm.js';
import type { Disposable, WraithOptions, WraithTheme } from './types.js';
import type { ITerminalInitOnlyOptions, ITerminalOptions } from './xterm-api.js';

export type WraithProfile = 'native' | 'xterm';
export type XtermOptions = ITerminalOptions & ITerminalInitOnlyOptions;
/** The mounted object: a native `Wraith`, or an xterm.js-compatible `Terminal`. */
export type WraithInstance = Wraith | Terminal;

export interface WraithEvents {
  /** The terminal is mounted and ready for writes. */
  onReady?: (terminal: WraithInstance) => void;
  /** User input (keys, paste, terminal replies) as a string. */
  onData?: (data: string) => void;
  /** User input as raw bytes. The xterm profile reports its binary (non-UTF-8) events here. */
  onBytes?: (bytes: Uint8Array) => void;
  onTitleChange?: (title: string) => void;
  onBell?: () => void;
  onResize?: (size: { cols: number; rows: number }) => void;
  /** Mount failures, GPU device loss, worker failure and socket errors. */
  onError?: (error: Error) => void;
}

interface CommonConfig {
  /**
   * A WebSocket URL to connect once mounted (`connect()` with backpressure in the
   * native profile), or an existing socket. Sockets created from a URL are closed
   * on dispose; sockets you pass in are left open.
   */
  src?: string | URL | WebSocket | null;
  /** Focus the terminal once it is ready. */
  autoFocus?: boolean;
}
export interface NativeBindingConfig extends CommonConfig {
  /** `Wraith.mount()`: libghostty-vt and the Rust WebGPU renderer in a worker (default). */
  profile?: 'native';
  options?: WraithOptions;
}
export interface XtermBindingConfig extends CommonConfig {
  /** `wraithterm/xterm`: the complete xterm.js 6.0 API with the WebGPU renderer. */
  profile: 'xterm';
  options?: XtermOptions;
}
export type WraithBindingConfig = NativeBindingConfig | XtermBindingConfig;

/** @internal Injection point for tests. */
export interface WraithRuntime {
  mount(host: HTMLElement, options: WraithOptions): Promise<Wraith>;
  xterm(options: XtermOptions): Promise<Terminal>;
  socket(url: string): WebSocket;
}
const defaultRuntime: WraithRuntime = {
  mount: async (host, options) => (await import('./index.js')).Wraith.mount(host, options),
  xterm: async (options) => new (await import('./xterm.js')).Terminal(options),
  socket: (url) => new WebSocket(url),
};

export class WraithDisposedError extends Error {
  constructor() {
    super('Wraith binding was disposed before the terminal finished mounting');
    this.name = 'WraithDisposedError';
  }
}

const NATIVE_LIVE = new Set(['theme', 'fontSize', 'lineHeight', 'font', 'fallbackFonts']);
const XTERM_INIT_ONLY = new Set(['cols', 'rows']);
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return false;
  if (a instanceof URL || b instanceof URL) return String(a) === String(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a),
    kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) =>
    same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
const profileOf = (config: WraithBindingConfig): WraithProfile =>
  config.profile === 'xterm' ? 'xterm' : 'native';
/** Bindings recreate the controller when this changes. */
export function remountKey(config: WraithBindingConfig): WraithProfile {
  return profileOf(config);
}
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class WraithController {
  /** The mounted terminal, or null before mount completes and after dispose. */
  terminal: WraithInstance | null = null;
  /** Resolves with the mounted terminal; rejects on mount failure or early dispose. */
  readonly ready: Promise<WraithInstance>;
  /** Replace freely; handlers are read at emit time, so swapping never resubscribes. */
  events: WraithEvents;
  readonly profile: WraithProfile;
  private config: WraithBindingConfig;
  private applied: WraithBindingConfig;
  private disposed = false;
  private disposing?: Promise<void>;
  private subscriptions: Disposable[] = [];
  private link?: { source: WraithBindingConfig['src']; dispose(): void };
  private updates = Promise.resolve();

  constructor(
    readonly host: HTMLElement,
    config: WraithBindingConfig = {},
    events: WraithEvents = {},
    private runtime: WraithRuntime = defaultRuntime,
  ) {
    this.config = this.applied = config;
    this.events = events;
    this.profile = profileOf(config);
    this.ready = this.start();
    this.ready.catch(() => {});
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private async start(): Promise<WraithInstance> {
    let terminal: WraithInstance;
    try {
      if (this.config.profile === 'xterm') {
        const instance = await this.runtime.xterm({ ...this.config.options });
        if (this.disposed) {
          instance.dispose();
          throw new WraithDisposedError();
        }
        instance.open(this.host);
        terminal = instance;
      } else {
        terminal = await this.runtime.mount(this.host, { ...this.config.options });
      }
    } catch (error) {
      if (error instanceof WraithDisposedError || this.disposed) throw new WraithDisposedError();
      const failure = toError(error);
      this.events.onError?.(failure);
      throw failure;
    }
    if (this.disposed) {
      await this.release(terminal);
      throw new WraithDisposedError();
    }
    this.terminal = terminal;
    this.subscribe(terminal);
    this.connect(this.config.src);
    // Changes made while mounting.
    await this.apply(this.config);
    if (this.config.autoFocus) terminal.focus();
    this.events.onReady?.(terminal);
    return terminal;
  }

  private subscribe(terminal: WraithInstance) {
    const e = () => this.events;
    if (this.profile === 'xterm') {
      const t = terminal as Terminal;
      this.subscriptions.push(
        t.onData((data) => e().onData?.(data)),
        t.onBinary((data) => {
          const bytes = new Uint8Array(data.length);
          for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
          e().onBytes?.(bytes);
        }),
        t.onTitleChange((title) => e().onTitleChange?.(title)),
        t.onBell(() => e().onBell?.()),
        t.onResize((size) => e().onResize?.(size)),
      );
    } else {
      const t = terminal as Wraith;
      this.subscriptions.push(
        t.onData((data) => e().onData?.(data)),
        t.onBytes((bytes) => e().onBytes?.(bytes)),
        t.onTitleChange((title) => e().onTitleChange?.(title)),
        t.onBell(() => e().onBell?.()),
        t.onResize((size) => e().onResize?.(size)),
        t.onError((error) => e().onError?.(error)),
      );
    }
  }

  private connect(source: WraithBindingConfig['src']) {
    this.link?.dispose();
    this.link = undefined;
    const terminal = this.terminal;
    if (!source || !terminal) return;
    let socket: WebSocket;
    let owned = false;
    try {
      if (typeof source === 'string' || source instanceof URL) {
        socket = this.runtime.socket(String(source));
        owned = true;
      } else socket = source;
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      this.events.onError?.(toError(error));
      return;
    }
    const failed = () => this.events.onError?.(new Error(`WebSocket error: ${socket.url}`));
    socket.addEventListener('error', failed);
    let wire: Disposable;
    if (this.profile === 'xterm') {
      const t = terminal as Terminal;
      const receive = (event: MessageEvent) => {
        const data = event.data;
        if (typeof data === 'string') t.write(data);
        else if (data instanceof ArrayBuffer) t.write(new Uint8Array(data));
        else if (data instanceof Blob)
          void data.arrayBuffer().then((buffer) => t.write(new Uint8Array(buffer)));
      };
      const send = (data: string | Uint8Array) => {
        if (socket.readyState === 1) socket.send(data);
      };
      socket.addEventListener('message', receive);
      const input = t.onData(send);
      const binary = t.onBinary((data) => {
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
        send(bytes);
      });
      wire = {
        dispose: () => {
          socket.removeEventListener('message', receive);
          input.dispose();
          binary.dispose();
        },
      };
    } else wire = (terminal as Wraith).connect(socket);
    this.link = {
      source,
      dispose: () => {
        wire.dispose();
        socket.removeEventListener('error', failed);
        if (owned && socket.readyState < 2) socket.close();
      },
    };
  }

  /** Apply new configuration. Profile changes need a new controller (see `remountKey`). */
  update(config: WraithBindingConfig): Promise<void> {
    this.config = config;
    if (!this.terminal || this.disposed) return Promise.resolve();
    const run = this.updates.then(() => this.apply(config));
    this.updates = run.catch(() => {});
    return run;
  }

  private async apply(config: WraithBindingConfig) {
    const terminal = this.terminal;
    if (!terminal || this.disposed) return;
    const previous = this.applied;
    this.applied = config;
    if (!same(previous.src, config.src)) this.connect(config.src);
    const before = (previous.options ?? {}) as Record<string, unknown>;
    const after = (config.options ?? {}) as Record<string, unknown>;
    const changed = new Set(
      [...Object.keys(before), ...Object.keys(after)].filter(
        (key) => !same(before[key], after[key]),
      ),
    );
    if (!changed.size) return;
    try {
      if (this.profile === 'xterm') {
        const t = terminal as Terminal;
        const mutable: Record<string, unknown> = {};
        for (const key of changed)
          if (!XTERM_INIT_ONLY.has(key) && after[key] !== undefined) mutable[key] = after[key];
        if (Object.keys(mutable).length) t.options = mutable as ITerminalOptions;
        if (changed.has('cols') || changed.has('rows'))
          t.resize((after.cols as number) ?? t.cols, (after.rows as number) ?? t.rows);
        return;
      }
      const t = terminal as Wraith;
      const next = after as WraithOptions;
      if (changed.has('theme') && next.theme) t.setTheme(next.theme as WraithTheme);
      if (changed.has('font') || changed.has('fallbackFonts') || changed.has('lineHeight')) {
        await t.setFont(
          next.font ?? new URL('../wasm/JetBrainsMono-Regular.ttf', import.meta.url),
          {
            fontSize: next.fontSize,
            lineHeight: next.lineHeight,
            fallbackFonts: next.fallbackFonts ?? [],
          },
        );
      } else if (changed.has('fontSize') && next.fontSize !== undefined)
        await t.setFontSize(next.fontSize);
      if ((changed.has('cols') || changed.has('rows')) && next.fit === false)
        await t.resize(next.cols ?? t.cols, next.rows ?? t.rows);
      if (changed.has('fit') && next.fit !== false) t.fit();
      const ignored = [...changed].filter(
        (key) => !NATIVE_LIVE.has(key) && !['cols', 'rows', 'fit'].includes(key),
      );
      if (ignored.length)
        console.warn(
          `Wraith: ${ignored.join(', ')} only apply at mount; remount (for example with a React key) to change them.`,
        );
    } catch (error) {
      this.events.onError?.(toError(error));
    }
  }

  /** Write once mounted. Resolves after the bytes are parsed (native) or queued (xterm). */
  async write(data: string | Uint8Array): Promise<void> {
    const terminal = await this.ready;
    if (this.profile === 'xterm')
      await new Promise<void>((resolve) => (terminal as Terminal).write(data, resolve));
    else await (terminal as Wraith).write(data);
  }

  focus(): void {
    this.terminal?.focus();
  }

  /** Idempotent. Resolves after the terminal's worker and GPU resources are released. */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    const terminal = this.terminal;
    this.terminal = null;
    this.link?.dispose();
    this.link = undefined;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    this.disposing = terminal
      ? this.release(terminal)
      : this.ready.then(
          () => {},
          () => {},
        );
    return this.disposing;
  }

  private async release(terminal: WraithInstance) {
    try {
      await terminal.dispose();
    } catch (error) {
      console.error('Wraith dispose', error);
    }
  }
}

/** Mount a terminal into `host`. The framework bindings are thin wrappers around this. */
export function createWraith(
  host: HTMLElement,
  config?: WraithBindingConfig,
  events?: WraithEvents,
): WraithController {
  return new WraithController(host, config, events);
}
