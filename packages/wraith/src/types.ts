export interface WraithTheme {
  foreground?: string;
  background?: string;
  cursor?: string;
}
export interface WraithOptions {
  cols?: number;
  rows?: number;
  /** CSS pixels. Rasterization follows devicePixelRatio captured at mount. */
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
