/**
 * `<wraith-term>` custom element. Importing `wraithterm/element` registers it.
 *
 * ```html
 * <wraith-term src="ws://localhost:7681" font-size="14" style="height: 420px"></wraith-term>
 * ```
 *
 * Attributes: `profile` (`native` | `xterm`), `cols`, `rows`, `font-size`,
 * `line-height`, `scrollback`, `theme` (JSON), `ligatures`, `screen-reader`,
 * `autofocus`, `src` (WebSocket URL). Giving `cols` or `rows` turns fitting off
 * unless `fit` is also present. The `options` property merges extra options
 * (fonts, a pool, xterm options) over the attributes.
 *
 * Events (`CustomEvent`, `detail` as noted): `wraith-ready` (terminal),
 * `wraith-data` (string), `wraith-bytes` (Uint8Array), `wraith-title` (string),
 * `wraith-bell`, `wraith-resize` ({cols, rows}), `wraith-error` (Error).
 */
import {
  WraithController,
  type WraithBindingConfig,
  type WraithEvents,
  type WraithInstance,
  type WraithProfile,
} from './binding.js';
import type { WraithOptions } from './types.js';
export type { WraithInstance, WraithProfile } from './binding.js';

const ATTRIBUTES = [
  'profile',
  'cols',
  'rows',
  'font-size',
  'line-height',
  'scrollback',
  'theme',
  'ligatures',
  'screen-reader',
  'fit',
  'autofocus',
  'src',
] as const;

// Importable during SSR: no DOM globals are touched unless they exist.
const Base: typeof HTMLElement =
  typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

function number(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function flag(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  return value !== 'false';
}

export class WraithTermElement extends Base {
  static get observedAttributes(): readonly string[] {
    return ATTRIBUTES;
  }
  private controller: WraithController | null = null;
  private extra: Record<string, unknown> = {};
  private pendingStop?: Promise<void>;
  private scheduled = false;

  /** The mounted `Wraith` or xterm `Terminal`; null until ready. */
  get terminal(): WraithInstance | null {
    return this.controller?.terminal ?? null;
  }
  /** Resolves with the mounted terminal. Rejects if the element is removed first. */
  get ready(): Promise<WraithInstance> {
    return this.controller?.ready ?? Promise.reject(new Error('<wraith-term> is not connected'));
  }
  /** Extra options merged over the attributes (fonts, a pool, xterm options …). */
  get options(): Record<string, unknown> {
    return this.extra;
  }
  set options(value: WraithOptions | Record<string, unknown>) {
    this.extra = { ...(value as Record<string, unknown>) };
    this.refresh();
  }
  write(data: string | Uint8Array): Promise<void> {
    return this.controller
      ? this.controller.write(data)
      : Promise.reject(new Error('<wraith-term> is not connected'));
  }
  override focus(): void {
    this.controller?.focus();
  }

  /** Attribute-derived configuration. */
  config(): WraithBindingConfig {
    const profile: WraithProfile = this.getAttribute('profile') === 'xterm' ? 'xterm' : 'native';
    const options: Record<string, unknown> = {};
    const cols = number(this.getAttribute('cols'));
    const rows = number(this.getAttribute('rows'));
    if (cols !== undefined) options.cols = cols;
    if (rows !== undefined) options.rows = rows;
    const fontSize = number(this.getAttribute('font-size'));
    if (fontSize !== undefined) options.fontSize = fontSize;
    const lineHeight = number(this.getAttribute('line-height'));
    if (lineHeight !== undefined) options.lineHeight = lineHeight;
    const scrollback = number(this.getAttribute('scrollback'));
    if (scrollback !== undefined) options.scrollback = scrollback;
    const theme = this.getAttribute('theme');
    if (theme) {
      try {
        options.theme = JSON.parse(theme);
      } catch {
        this.emit('wraith-error', new TypeError('<wraith-term> theme must be JSON'));
      }
    }
    const fit = flag(this.getAttribute('fit'));
    if (profile === 'native') {
      const ligatures = flag(this.getAttribute('ligatures'));
      if (ligatures !== undefined) options.ligatures = ligatures;
      const reader = flag(this.getAttribute('screen-reader'));
      if (reader !== undefined) options.screenReaderMode = reader;
      if (fit !== undefined) options.fit = fit;
      else if (cols !== undefined || rows !== undefined) options.fit = false;
    } else {
      const reader = flag(this.getAttribute('screen-reader'));
      if (reader !== undefined) options.screenReaderMode = reader;
    }
    return {
      profile,
      options: { ...options, ...this.extra },
      src: this.getAttribute('src'),
      autoFocus: this.hasAttribute('autofocus'),
    } as WraithBindingConfig;
  }

  private emit(type: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
  private events(): WraithEvents {
    return {
      onReady: (terminal) => this.emit('wraith-ready', terminal),
      onData: (data) => this.emit('wraith-data', data),
      onBytes: (bytes) => this.emit('wraith-bytes', bytes),
      onTitleChange: (title) => this.emit('wraith-title', title),
      onBell: () => this.emit('wraith-bell'),
      onResize: (size) => this.emit('wraith-resize', size),
      onError: (error) => this.emit('wraith-error', error),
    };
  }

  connectedCallback(): void {
    this.refresh();
  }
  disconnectedCallback(): void {
    // Moving the element (remove + insert in one task) keeps the terminal.
    queueMicrotask(() => {
      if (!this.isConnected) this.stop();
    });
  }
  attributeChangedCallback(): void {
    this.refresh();
  }

  /** Coalesce attribute changes made in one task into one mount or update. */
  private refresh() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.isConnected) return;
      const config = this.config();
      const profile = config.profile === 'xterm' ? 'xterm' : 'native';
      if (this.controller && this.controller.profile !== profile) this.stop();
      if (this.controller) void this.controller.update(config).catch(() => {});
      else this.controller = new WraithController(this, config, this.events());
    });
  }
  private stop() {
    const current = this.controller;
    this.controller = null;
    if (current) this.pendingStop = current.dispose();
  }
  /** Resolves after the last removed terminal released its worker. */
  get stopped(): Promise<void> {
    return this.pendingStop ?? Promise.resolve();
  }
}

/** Register the element under `name` (default `wraith-term`). Safe to call repeatedly and during SSR. */
export function defineWraithElement(name = 'wraith-term'): void {
  if (typeof customElements === 'undefined' || customElements.get(name)) return;
  customElements.define(
    name,
    name === 'wraith-term' ? WraithTermElement : class extends WraithTermElement {},
  );
  if (typeof document !== 'undefined' && !document.getElementById(`${name}-style`)) {
    const style = document.createElement('style');
    style.id = `${name}-style`;
    // :where() keeps specificity zero, so any author rule wins.
    style.textContent = `:where(${name}){display:block;position:relative;height:360px;overflow:hidden}`;
    document.head.append(style);
  }
}
defineWraithElement();

declare global {
  interface HTMLElementTagNameMap {
    'wraith-term': WraithTermElement;
  }
}
