import { Terminal as RuntimeTerminal } from '@wraith-terminal/xterm-base/lib/xterm.mjs';
import type {
  Terminal as TerminalApi,
  ITerminalOptions,
  ITerminalInitOnlyOptions,
} from './xterm-api.js';
import { XtermRenderer, type RendererState } from './xterm-renderer.js';
import { accelerateInput } from './xterm-input.js';
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
/** Complete xterm.js 6.0 public API. Construction/open remain synchronous;
 * WebGPU warms asynchronously while xterm's DOM renderer remains usable. */
export class Terminal extends XtermTerminal {
  private wraithRenderer: XtermRenderer | undefined;
  private wraithDisposed = false;
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
  override open(parent: HTMLElement): void {
    super.open(parent);
    if (!this.wraithRenderer && !this.wraithDisposed)
      this.wraithRenderer = XtermRenderer.install(this);
  }
  override dispose(): void {
    this.wraithDisposed = true;
    super.dispose();
  }
}
