/**
 * Screen-reader output summaries computed from viewport text snapshots.
 *
 * Runs in the terminal worker, next to the engine, so the main thread receives
 * only changed mirror rows and finished announcement strings. Everything here
 * is pure and clock-injected so it can be tested without a browser.
 */
export interface AnnouncerOptions {
  /** Minimum milliseconds between announcements. */
  interval: number;
  /** Most rows one announcement may contain before the overflow notice. */
  maxLines: number;
  /** Most UTF-16 code units one announcement may contain. */
  maxCharacters: number;
  /** A changed row is announced only once unchanged for this long, so redraws
   * (progress bars, spinners, typing) collapse to their settled text. */
  settle: number;
  /** A row that never settles is announced after this long anyway. */
  maxHold: number;
}
export const DEFAULT_ANNOUNCER: AnnouncerOptions = {
  interval: 500,
  maxLines: 20,
  maxCharacters: 4000,
  settle: 150,
  maxHold: 3000,
};
export const OVERFLOW_NOTICE = 'Output is arriving quickly. Announcements paused until it settles.';

/** Split engine text into exactly `rows` rows, trailing padding removed. */
export function splitRows(text: string, rows: number): string[] {
  const lines = text.split('\n');
  const out = new Array<string>(rows);
  for (let i = 0; i < rows; i++) out[i] = (lines[i] ?? '').trimEnd();
  return out;
}

/**
 * How many rows `current` scrolled up relative to `previous`: the smallest
 * shift with the most identical non-blank rows in the overlap. Rows that were
 * edited in place (a prompt gaining its command, a spinner) may mismatch; a
 * shift is accepted when at least half of the overlap's non-blank rows match.
 * Returns zero when nothing lines up: a replacement or in-place redraw, whose
 * changed rows are all reported either way.
 */
export function scrollShift(previous: readonly string[], current: readonly string[]): number {
  const rows = Math.min(previous.length, current.length);
  let best = 0,
    bestMatches = 0;
  for (let shift = 0; shift < rows; shift++) {
    let matches = 0,
      candidates = 0;
    for (let i = 0; i + shift < rows; i++) {
      const before = previous[i + shift]!;
      if (!before) continue;
      candidates++;
      if (before === current[i]) matches++;
    }
    if (candidates === 0) continue;
    if (matches > bestMatches && matches * 2 >= candidates) {
      best = shift;
      bestMatches = matches;
      if (matches === candidates) break;
    }
  }
  return best;
}

interface Pending {
  text: string;
  first: number;
  changed: number;
}

export class OutputAnnouncer {
  private options: AnnouncerOptions;
  private previous: string[] | null = null;
  /** Absolute line number of viewport row 0, advanced by detected scrolling. */
  private origin = 0;
  private pending = new Map<number, Pending>();
  private announced = new Map<number, string>();
  private lastFlush = -Infinity;
  private lastChange = -Infinity;
  private overflow = false;
  private notice: string | undefined;
  constructor(options: Partial<AnnouncerOptions> = {}) {
    this.options = { ...DEFAULT_ANNOUNCER, ...options };
  }
  configure(options: Partial<AnnouncerOptions>) {
    this.options = { ...this.options, ...options };
  }
  /** Adopt the current screen without announcing it (resize, user scroll,
   * screen switch, enabling announcements). Pending speech is discarded. */
  baseline(rows: string[] | null) {
    this.previous = rows;
    this.pending.clear();
    this.notice = undefined;
    this.overflow = false;
  }
  get overflowing() {
    return this.overflow;
  }
  /**
   * Record a viewport snapshot. `skipRow` is excluded (the cursor row while the
   * user is typing, whose echo the screen reader already speaks).
   */
  sample(rows: string[], now: number, skipRow = -1) {
    const previous = this.previous;
    if (!previous || previous.length !== rows.length) {
      this.baseline(rows);
      return;
    }
    const shift = scrollShift(previous, rows);
    this.origin += shift;
    let changed = shift > 0;
    for (let i = 0; i < rows.length; i++) {
      const j = i + shift;
      const text = rows[i]!;
      if (j < previous.length && previous[j] === text) continue;
      changed = true;
      const line = this.origin + i;
      if (!text.trim()) {
        // Erased rows may later show the same text again (clear, then rerun).
        this.pending.delete(line);
        this.announced.delete(line);
        continue;
      }
      if (i === skipRow) {
        this.pending.delete(line);
        continue;
      }
      const entry = this.pending.get(line);
      if (entry) {
        entry.text = text;
        entry.changed = now;
      } else this.pending.set(line, { text, first: now, changed: now });
    }
    this.previous = rows;
    if (changed) this.lastChange = now;
    if (this.overflow) {
      this.pending.clear();
      return;
    }
    let characters = 0;
    for (const entry of this.pending.values()) characters += entry.text.length + 1;
    if (this.pending.size > this.options.maxLines || characters > this.options.maxCharacters) {
      this.overflow = true;
      this.pending.clear();
      this.notice = OVERFLOW_NOTICE;
    }
  }
  /** Return text to announce now, if any; call again by `deadline()`. */
  flush(now: number): string | undefined {
    if (now - this.lastFlush < this.options.interval) return;
    if (this.notice) {
      const notice = this.notice;
      this.notice = undefined;
      this.lastFlush = now;
      return notice;
    }
    if (this.overflow) {
      if (now - this.lastChange < this.options.interval) return;
      // Output settled: resume, and summarize with the screen's final rows
      // (typically the last result and the prompt).
      this.overflow = false;
      const tail = (this.previous ?? []).filter((row) => row.trim()).slice(-2);
      for (const [i, row] of (this.previous ?? []).entries())
        this.announced.set(this.origin + i, row);
      this.lastFlush = now;
      return tail.length ? `Output settled. ${tail.join('\n')}` : 'Output settled.';
    }
    if (!this.pending.size) return;
    const ready: [number, string][] = [];
    for (const [line, entry] of this.pending) {
      if (now - entry.changed >= this.options.settle || now - entry.first >= this.options.maxHold)
        ready.push([line, entry.text]);
    }
    if (!ready.length) return;
    ready.sort((a, b) => a[0] - b[0]);
    const lines: string[] = [];
    for (const [line, text] of ready) {
      this.pending.delete(line);
      // De-duplicate: a row redrawn back to text already spoken stays silent.
      if (this.announced.get(line) === text) continue;
      this.announced.set(line, text);
      lines.push(text);
    }
    for (const line of this.announced.keys())
      if (line < this.origin - 4096) this.announced.delete(line);
    if (!lines.length) return;
    this.lastFlush = now;
    return lines.join('\n');
  }
  /** When `flush` may next produce something, or undefined when idle. */
  deadline(now: number): number | undefined {
    if (!this.notice && !this.overflow && !this.pending.size) return;
    let at = this.lastFlush + this.options.interval;
    if (this.overflow && !this.notice) at = Math.max(at, this.lastChange + this.options.interval);
    if (!this.notice && !this.overflow) {
      let earliest = Infinity;
      for (const entry of this.pending.values())
        earliest = Math.min(
          earliest,
          Math.min(entry.changed + this.options.settle, entry.first + this.options.maxHold),
        );
      at = Math.max(at, earliest);
    }
    return Math.max(now, at);
  }
}

/** Index/text pairs for rows that differ from the previously mirrored rows. */
export function mirrorPatch(previous: readonly string[], current: readonly string[]) {
  const patch: [number, string][] = [];
  for (let i = 0; i < current.length; i++)
    if (previous[i] !== current[i]) patch.push([i, current[i]!]);
  return patch;
}
