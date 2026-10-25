import { Terminal as RuntimeTerminal } from '@wraith-terminal/xterm-base/lib/xterm.mjs';
import type {
  Terminal as TerminalApi,
  ITerminalOptions,
  ITerminalInitOnlyOptions,
} from './xterm-api.js';
import { XtermRenderer, type RendererState } from './xterm-renderer.js';
import { accelerateInput } from './xterm-input.js';
import { installKeyboardExit } from './xterm-accessibility.js';
const XtermTerminal: typeof TerminalApi = RuntimeTerminal;
export type * from './xterm-api.js';
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
