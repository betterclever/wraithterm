import { Terminal as RuntimeTerminal } from '@wraith-terminal/xterm-base/lib/xterm.mjs';
import type {
  Terminal as TerminalApi,
  ITerminalOptions,
  ITerminalInitOnlyOptions,
} from './xterm-api.js';
import { XtermRenderer, type RendererState } from './xterm-renderer.js';
import { accelerateInput } from './xterm-input.js';
import { installKeyboardExit } from './xterm-accessibility.js';
import type { WraithEffects } from './effects.js';
const XtermTerminal: typeof TerminalApi = RuntimeTerminal;
export type * from './xterm-api.js';
export { CommandBlocksAddon } from './xterm-commands.js';
export {
  SHELL_INTEGRATION,
  DEFAULT_COMMAND_COLORS,
  type CommandBlock,
  type CommandBlockOptions,
  type CommandColors,
  type CommandRows,
  type CommandState,
} from './command-types.js';
export { parseOsc133, type Osc133Step } from './osc133.js';
export type {
  WraithEffects,
  WraithCrtOptions,
  WraithBloomOptions,
  WraithCursorTrailOptions,
} from './effects.js';
/** Complete xterm.js 6.0 public API. Construction/open remain synchronous;
 * WebGPU warms asynchronously while xterm's DOM renderer remains usable. */
export class Terminal extends XtermTerminal {
  private wraithRenderer: XtermRenderer | undefined;
  private wraithDisposed = false;
  private wraithExit: { dispose(): void } | undefined;
  constructor(options?: ITerminalOptions & ITerminalInitOnlyOptions) {
    super(options);
    accelerateInput(this);
  }
  /** Resolves after GPU initialization. False means the DOM fallback is active. */
  get webgpuReady(): Promise<boolean> {
    return this.wraithRenderer?.ready ?? Promise.resolve(false);
  }
  get renderer(): RendererState {
    return this.wraithRenderer
      ? this.wraithRenderer.active
        ? this.wraithRenderer.state
        : 'external'
      : 'dom';
  }
  get rendererFallbackReason(): string | undefined {
    return this.wraithRenderer?.reason;
  }
  /**
   * Wraith extension (not part of xterm.js): GPU post-process effects, the
   * same as `Wraith.mount({ effects })`. Call after `open()`. Rejects when the
   * WebGPU renderer is unavailable or a custom shader fails to compile; the
   * previous effects stay in place.
   */
  setEffects(effects: WraithEffects | null): Promise<void> {
    if (!this.wraithRenderer) return Promise.reject(new Error('Call open() before setEffects()'));
    return this.wraithRenderer.effects.set(effects);
  }
  override open(parent: HTMLElement): void {
    super.open(parent);
    if (!this.wraithRenderer && !this.wraithDisposed)
      this.wraithRenderer = XtermRenderer.install(this);
    if (!this.wraithExit && !this.wraithDisposed) this.wraithExit = installKeyboardExit(this);
  }
  override dispose(): void {
    this.wraithDisposed = true;
    this.wraithExit?.dispose();
    super.dispose();
  }
}
