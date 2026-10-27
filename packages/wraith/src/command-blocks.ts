import {
  DEFAULT_COMMAND_COLORS,
  promptKeyDirection,
  type CommandBlock,
  type CommandBlockOptions,
  type CommandColors,
} from './command-types.js';
import type { RawCommandBlock, Reply } from './protocol.js';
import type { Disposable, KeyEventHandler } from './types.js';

/** What the controller needs from its terminal, without widening Wraith's API. */
export interface CommandHost {
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Physical cell size and device pixel ratio. */
  geometry(): { cellWidth: number; cellHeight: number; dpr: number; cols: number; rows: number };
  request<T>(command: Record<string, unknown> & { type: string }): Promise<T>;
  addKeyHandler(handler: KeyEventHandler): Disposable;
  /** Reserve CSS pixels left of the canvas; false when the layout cannot. */
  reserve(pixels: number): boolean;
  error(error: unknown): void;
}

const GUTTER = 3;
/** Space reserved for the gutter so it never covers the first column. */
const RESERVE = 6;

/** Freeze a worker block into the public shape, with lazy output text. */
function publicBlock(raw: RawCommandBlock, host: CommandHost): CommandBlock {
  const [prompt, input, output, end] = raw.rows;
  const done = raw.state === 3;
  return Object.freeze({
    id: raw.id,
    command: raw.command,
    state: done ? 'done' : 'running',
    exitCode: raw.exitCode,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    durationMs:
      raw.startedAt !== undefined && raw.finishedAt !== undefined
        ? raw.finishedAt - raw.startedAt
        : undefined,
    rows: Object.freeze({ prompt, input, output, end }),
    truncated: raw.truncated,
    output: async () => {
      const text = await host.request<[string, boolean] | undefined>({
        type: 'command-text',
        block: raw.id,
        input: false,
      });
      return text?.[0] ?? '';
    },
  } satisfies CommandBlock);
}

/**
 * Main-thread side of OSC 133 command blocks for `Wraith.mount()`. Creates no
 * DOM and attaches no listeners until the worker reports a first block.
 */
export class CommandBlocks {
  private listeners = new Set<(block: CommandBlock) => void>();
  private marks: number[] = [];
  private primary = true;
  private overlay?: HTMLCanvasElement;
  private button?: HTMLButtonElement;
  private hovered = -1;
  private abort = new AbortController();
  private colors: CommandColors;
  private options: Required<Omit<CommandBlockOptions, 'colors'>>;
  private keys?: Disposable;
  private disposed = false;
  constructor(
    private host: CommandHost,
    options: CommandBlockOptions | false = {},
  ) {
    const enabled = options !== false;
    const o = options || {};
    this.options = {
      gutter: enabled && o.gutter !== false,
      copyButton: enabled && o.copyButton !== false,
      keyBindings: enabled && o.keyBindings !== false,
    };
    this.colors = { ...DEFAULT_COMMAND_COLORS, ...o.colors };
  }
  receive(reply: Extract<Reply, { type: 'command' | 'marks' }>) {
    if (this.disposed) return;
    if (reply.type === 'command') {
      const block = publicBlock(reply.block, this.host);
      for (const listener of this.listeners) {
        try {
          listener(block);
        } catch (error) {
          console.error('Wraith command listener', error);
        }
      }
      return;
    }
    this.activate();
    this.marks = reply.marks;
    this.primary = reply.primary;
    this.draw();
  }
  /** First block: create the overlay and bind keys. */
  private activate() {
    if (this.overlay || this.keys) return;
    if (this.options.keyBindings)
      this.keys = this.host.addKeyHandler((event) => {
        const direction = promptKeyDirection(event);
        if (!direction || !this.primary) return true;
        event.preventDefault();
        void this.jumpToPrompt(direction).catch((error) => this.host.error(error));
        return false;
      });
    if (!this.options.gutter && !this.options.copyButton) return;
    const reserved = this.options.gutter && this.host.reserve(RESERVE);
    const overlay = document.createElement('canvas');
    overlay.className = 'wraith-command-gutter';
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
      position: 'absolute',
      // In the reserved space when there is one; otherwise over column 0.
      left: reserved ? `${(RESERVE - GUTTER) / 2}px` : '0',
      top: '0',
      width: `${GUTTER}px`,
      pointerEvents: 'none',
    });
    this.overlay = overlay;
    this.host.element.append(overlay);
    if (!this.options.copyButton) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wraith-command-copy';
    button.textContent = 'Copy output';
    Object.assign(button.style, {
      position: 'absolute',
      right: '8px',
      top: '0',
      display: 'none',
      font: '500 11px/1 system-ui, sans-serif',
      padding: '4px 8px',
      borderRadius: '6px',
      border: '1px solid rgba(255,255,255,0.18)',
      background: 'rgba(22,27,34,0.92)',
      color: '#e6edf3',
      cursor: 'pointer',
      zIndex: '1',
    });
    button.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        const id = this.hovered;
        if (id < 0) return;
        void this.copyCommandOutput(id)
          .then(() => {
            if (this.hovered !== id) return;
            button.textContent = 'Copied';
            setTimeout(() => {
              if (button.textContent === 'Copied') button.textContent = 'Copy output';
            }, 1200);
          })
          .catch((error) => this.host.error(error));
      },
      { signal: this.abort.signal },
    );
    button.addEventListener('pointerdown', (event) => event.stopPropagation(), {
      signal: this.abort.signal,
    });
    this.button = button;
    this.host.element.append(button);
    this.host.element.addEventListener('pointermove', (event) => this.hover(event), {
      signal: this.abort.signal,
    });
    this.host.element.addEventListener('pointerleave', () => this.hide(), {
      signal: this.abort.signal,
    });
  }
  private color(state: number, exit: number) {
    if (state === 2) return this.colors.running;
    return exit === 1
      ? this.colors.success
      : exit === 2
        ? this.colors.failure
        : this.colors.unknown;
  }
  /** Redraw the gutter from the latest extents. */
  draw() {
    const overlay = this.overlay;
    if (!overlay) return;
    const { cellHeight, dpr, rows } = this.host.geometry();
    const width = Math.round(GUTTER * dpr),
      height = Math.round(rows * cellHeight);
    if (overlay.width !== width || overlay.height !== height) {
      overlay.width = width;
      overlay.height = height;
      overlay.style.height = `${height / dpr}px`;
    }
    const context = overlay.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (this.options.gutter && this.primary) {
      const inset = Math.max(1, Math.round(dpr));
      for (let i = 0; i + 4 < this.marks.length; i += 5) {
        const state = this.marks[i + 1]!,
          exit = this.marks[i + 2]!,
          first = this.marks[i + 3]!,
          last = this.marks[i + 4]!;
        context.fillStyle = this.color(state, exit);
        const top = first * cellHeight + inset,
          bottom = (last + 1) * cellHeight - inset;
        context.fillRect(0, top, width, Math.max(1, bottom - top));
      }
    }
    if (this.hovered >= 0 && !this.markFor(this.hovered)) this.hide();
  }
  private markFor(id: number): number | undefined {
    for (let i = 0; i + 4 < this.marks.length; i += 5) if (this.marks[i] === id) return i;
    return undefined;
  }
  private hover(event: PointerEvent) {
    const button = this.button;
    if (!button || !this.primary) return;
    if (event.target === button) return;
    const { cellHeight, dpr } = this.host.geometry();
    const rect = this.host.canvas.getBoundingClientRect();
    const row = Math.floor(((event.clientY - rect.top) * dpr) / cellHeight);
    for (let i = 0; i + 4 < this.marks.length; i += 5) {
      if (this.marks[i + 1] !== 3) continue;
      const first = this.marks[i + 3]!,
        last = this.marks[i + 4]!;
      if (row < first || row > last) continue;
      const id = this.marks[i]!;
      if (this.hovered !== id) {
        this.hovered = id;
        button.textContent = 'Copy output';
      }
      button.style.top = `${(first * cellHeight) / dpr + 2}px`;
      button.style.display = 'block';
      return;
    }
    this.hide();
  }
  private hide() {
    this.hovered = -1;
    if (this.button) this.button.style.display = 'none';
  }
  async commands(): Promise<CommandBlock[]> {
    const blocks = await this.host.request<RawCommandBlock[]>({ type: 'commands' });
    return blocks.filter((b) => b.state >= 2).map((b) => publicBlock(b, this.host));
  }
  onCommand(listener: (block: CommandBlock) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  /** Scroll the previous (-1) or next (1) prompt to the top of the viewport. */
  jumpToPrompt(direction: -1 | 1): Promise<boolean> {
    if (direction !== -1 && direction !== 1)
      return Promise.reject(new RangeError('Direction must be -1 or 1'));
    return this.host.request<boolean>({ type: 'jump-prompt', direction });
  }
  async copyCommandOutput(id: number): Promise<string> {
    const text = await this.host.request<[string, boolean] | undefined>({
      type: 'command-text',
      block: id,
      input: false,
    });
    if (!text) throw new RangeError(`No command block ${id}`);
    await navigator.clipboard.writeText(text[0]);
    return text[0];
  }
  dispose() {
    this.disposed = true;
    this.hovered = -1;
    this.abort.abort();
    this.keys?.dispose();
    this.overlay?.remove();
    this.button?.remove();
    this.listeners.clear();
  }
}
