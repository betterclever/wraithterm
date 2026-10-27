export interface WraithTheme {
  foreground?: string;
  background?: string;
  cursor?: string;
}
export interface WraithOptions {
  cols?: number;
  rows?: number;
  /** CSS pixels. Rasterization follows changes to devicePixelRatio. */
  fontSize?: number;
  lineHeight?: number;
  font?: string | URL | Uint8Array;
  fallbackFonts?: (string | URL | Uint8Array)[];
  scrollback?: number;
  fit?: boolean;
  theme?: WraithTheme;
  /** Maintain an accessible text mirror. Off by default to minimize DOM work. */
  screenReaderMode?: boolean;
  /** Maximum unacknowledged input bytes. Defaults to 8 MiB. */
  maxPendingBytes?: number;
  /**
   * Decoded Kitty graphics image bytes each screen may store. Defaults to
   * 64 MiB; when full, Ghostty evicts the oldest images. Zero disables Kitty
   * graphics.
   */
  imageStorageLimit?: number;
  /**
   * Programming-font ligatures (`=>`, `!=`, `->`, …) shaped across cells. Off by
   * default; the word under the cursor shows its separate characters.
   * Complex scripts (Arabic, Indic, Thai, …) are always shaped across cells.
   */
  ligatures?: boolean;
  /**
   * Share workers with other terminals. Create one with `Wraith.pool()`;
   * without it, each terminal has a dedicated worker.
   */
  pool?: import('./pool.js').WraithPool;
}
export interface WraithStats {
  frames: number;
  inputBytes: number;
  parseMs: number;
  renderMs: number;
  uploadBytes: number;
  atlasGlyphs: number;
  atlasHits: number;
  atlasMisses: number;
  atlasResets: number;
  renderP50Ms: number;
  renderP95Ms: number;
  renderP99Ms: number;
  activeFps: number;
  adapter: string;
}
export type Workload = 'sparse' | 'dense' | 'scroll';
export interface BenchmarkOptions {
  frames?: number;
  warmup?: number;
  workload?: Workload;
}
export interface BenchmarkResult {
  workload: Workload;
  frames: number;
  cols: number;
  rows: number;
  elapsedMs: number;
  /** Counts frames completed in batches fenced every 32 submissions; not display FPS. */
  fencedFramesPerSecond: number;
  cpuP50Ms: number;
  cpuP95Ms: number;
  cpuP99Ms: number;
  inputMiBPerSecond: number;
  adapter: string;
  userAgent: string;
}
export interface Disposable {
  dispose(): void;
}
export interface WraithConnectOptions {
  /** WebSocket subprotocols. */
  protocols?: string | string[];
  /**
   * Read with `WebSocketStream` where the browser provides it, so reading
   * pauses while the parser is behind. Defaults to true; false always uses
   * `WebSocket` events in the worker.
   */
  stream?: boolean;
}
export interface WraithCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}
/**
 * A WebSocket opened and read by the terminal's worker. Output is parsed there
 * without crossing the page's main thread; keystrokes, paste and terminal
 * replies are sent from the worker in order.
 */
export interface WraithConnection extends Disposable {
  /** Resolves when the socket opens; rejects if it closes first. */
  readonly opened: Promise<void>;
  /** Resolves after the socket closes and every byte received before the close is parsed. */
  readonly closed: Promise<WraithCloseEvent>;
  /** `stream` (WebSocketStream) or `events` (WebSocket); undefined until open. */
  readonly transport: 'stream' | 'events' | undefined;
  /** Send to the server, ordered with terminal input. Queued until the socket opens. */
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onOpen(listener: () => void): Disposable;
  onClose(listener: (event: WraithCloseEvent) => void): Disposable;
  onError(listener: (error: Error) => void): Disposable;
}
/** Native Ghostty search uses ASCII-insensitive matching; other UTF-8 bytes match exactly. */
export interface SearchResult {
  total: number;
  /** Newest-to-oldest match index; -1 if nothing is selected. */
  index: number;
}
export interface SelectionPosition {
  x: number;
  y: number;
}
export type KeyEventHandler = (event: KeyboardEvent) => boolean;
export class BackpressureError extends Error {
  constructor() {
    super('Wraith input queue is full. Await write() before submitting more input.');
    this.name = 'BackpressureError';
  }
}
export function packColor(value: string): number {
  if (!/^#[\da-f]{6}$/i.test(value)) throw new TypeError(`Expected #rrggbb, received ${value}`);
  return (
    parseInt(value.slice(1, 3), 16) |
    (parseInt(value.slice(3, 5), 16) << 8) |
    (parseInt(value.slice(5, 7), 16) << 16)
  );
}
export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}
