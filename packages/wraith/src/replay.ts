/**
 * Deterministic replay: an indexed timeline, verified keyframes and a seek
 * cursor. Nothing here touches the DOM, so the same code drives the browser
 * player and headless tests.
 *
 * Seeking restores the nearest keyframe valid at the target and replays the
 * bytes after it. A keyframe is a libghostty VT snapshot (`Headless.snapshot`)
 * taken from a linear replay. It is only used after a second engine, restored
 * from it, matched the linear replay on grid digest and snapshot at sampled
 * points and at the end of the range it covers. Outside verified ranges the
 * cursor replays from the start of the recording, which is always exact.
 */
import type { Recording } from './recording.js';

/** Full reset (RIS) before restoring a keyframe or replaying from the start. */
export const RESET = Uint8Array.of(0x1b, 0x63);

/** Engine events of a recording in typed arrays; plain data, transferable to a worker. */
export interface CompactTimeline {
  cols: number;
  rows: number;
  /** Concatenated output bytes. */
  bytes: Uint8Array;
  /** Per event: 0 output, 1 resize. */
  kind: Uint8Array;
  /** Byte offset before each event; length is events + 1. */
  offset: Uint32Array;
  /** Grid size after each event. */
  cols16: Uint16Array;
  rows16: Uint16Array;
  /** Playback time of each event in seconds. */
  time: Float64Array;
  /** Per event: SYNC_BEGIN when it starts a synchronized update, ALT_ENTER
   * when it starts by switching to the alternate screen. */
  flags: Uint8Array;
}

export const SYNC_BEGIN = 1;
export const ALT_ENTER = 2;

export interface TimelineMarker {
  time: number;
  label: string;
}

export interface TimelineOptions {
  /** Shorten pauses longer than this many seconds. Defaults to the recording's limit. */
  idleTimeLimit?: number;
}

function clampSize(cols: number, rows: number): [number, number] {
  const c = Math.min(512, Math.max(1, Math.round(cols)));
  return [c, Math.min(512, Math.floor(65536 / c), Math.max(1, Math.round(rows)))];
}

function paletteBytes(palette: string[]): Uint8Array {
  return new TextEncoder().encode(
    palette
      .map((hex, index) => {
        const [r, g, b] = [1, 3, 5].map((at) => hex.slice(at, at + 2));
        return `\x1b]4;${index};rgb:${r}/${g}/${b}\x1b\\`;
      })
      .join(''),
  );
}

type Mark = { at: number; end: number; type: 'sync-on' | 'sync-off' | 'alt-on' | 'reset' };

/**
 * Finds DEC private mode changes that matter for replay in an output stream:
 * synchronized output (2026) and alternate-screen entry (47, 1047, 1049), plus
 * full resets. `at` is where the sequence's ESC starts, `end` just after it.
 */
function scanModes(bytes: Uint8Array): Mark[] {
  const marks: Mark[] = [];
  let state = 0,
    start = 0,
    param = 0,
    params: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte === 0x1b) {
      state = 1;
      start = i;
      continue;
    }
    if (state === 1) {
      if (byte === 0x5b) state = 2;
      else {
        if (byte === 0x63) marks.push({ at: start, end: i + 1, type: 'reset' });
        state = 0;
      }
    } else if (state === 2) {
      state = byte === 0x3f ? 3 : 0;
      params = [];
      param = 0;
    } else if (state === 3) {
      if (byte >= 0x30 && byte <= 0x39) param = param * 10 + byte - 0x30;
      else if (byte === 0x3b) {
        params.push(param);
        param = 0;
      } else {
        params.push(param);
        if (byte === 0x68 || byte === 0x6c) {
          const set = byte === 0x68;
          if (params.includes(2026))
            marks.push({ at: start, end: i + 1, type: set ? 'sync-on' : 'sync-off' });
          if (set && params.some((p) => p === 47 || p === 1047 || p === 1049))
            marks.push({ at: start, end: i + 1, type: 'alt-on' });
        }
        state = 0;
      }
    }
  }
  return marks;
}

/** The output and resize events of a recording, indexed for seeking. */
export class Timeline implements CompactTimeline {
  readonly cols: number;
  readonly rows: number;
  readonly bytes: Uint8Array;
  readonly kind: Uint8Array;
  readonly offset: Uint32Array;
  readonly cols16: Uint16Array;
  readonly rows16: Uint16Array;
  readonly time: Float64Array;
  readonly flags: Uint8Array;
  /** Playback length in seconds after idle compression. */
  readonly duration: number;
  readonly markers: TimelineMarker[];
  /** For each state index, the state a display shows: the same index, or the
   * last one before a still-open synchronized update began. A terminal shows
   * its last complete frame while an update is held. */
  readonly display: Uint32Array;
  constructor(
    data: CompactTimeline,
    duration: number,
    markers: TimelineMarker[] = [],
    display?: Uint32Array,
  ) {
    this.cols = data.cols;
    this.rows = data.rows;
    this.bytes = data.bytes;
    this.kind = data.kind;
    this.offset = data.offset;
    this.cols16 = data.cols16;
    this.rows16 = data.rows16;
    this.time = data.time;
    this.flags = data.flags;
    this.duration = duration;
    this.markers = markers;
    this.display = display ?? Uint32Array.from({ length: data.kind.length + 1 }, (_, i) => i);
  }
  static from(recording: Recording, options: TimelineOptions = {}): Timeline {
    const limit = options.idleTimeLimit ?? recording.idleTimeLimit;
    const compress = (gap: number) => (limit && limit > 0 ? Math.min(gap, limit) : gap);
    const prelude = recording.theme ? paletteBytes(recording.theme.palette) : undefined;
    // Pass one: the output stream, raw engine events and markers.
    type Raw = { start: number; end: number; cols: number; rows: number; time: number };
    const raw: Raw[] = [];
    const markers: TimelineMarker[] = [];
    let total = prelude?.byteLength ?? 0;
    for (const event of recording.events)
      if (event.type === 'output') total += event.data.byteLength;
    const bytes = new Uint8Array(total);
    let [cols, rows] = clampSize(recording.cols, recording.rows);
    const [startCols, startRows] = [cols, rows];
    let written = 0;
    if (prelude) {
      bytes.set(prelude);
      written = prelude.byteLength;
      raw.push({ start: 0, end: written, cols, rows, time: 0 });
    }
    let source = 0,
      playback = 0;
    for (const event of recording.events) {
      const gap = Math.max(0, event.time - source);
      source = Math.max(source, event.time);
      playback += compress(gap);
      if (event.type === 'marker') markers.push({ time: playback, label: event.label });
      else if (event.type === 'output' && event.data.byteLength) {
        bytes.set(event.data, written);
        raw.push({
          start: written,
          end: written + event.data.byteLength,
          cols,
          rows,
          time: playback,
        });
        written += event.data.byteLength;
      } else if (event.type === 'resize') {
        [cols, rows] = clampSize(event.cols, event.rows);
        raw.push({ start: written, end: written, cols: -cols, rows, time: playback });
      }
    }
    // Pass two: start an event at every synchronized-update begin and
    // alternate-screen entry, even when the sequence began in an earlier write.
    const marks = scanModes(bytes);
    const cuts = new Map<number, number>();
    for (const mark of marks)
      if (mark.type === 'sync-on' || mark.type === 'alt-on')
        cuts.set(
          mark.at,
          (cuts.get(mark.at) ?? 0) | (mark.type === 'sync-on' ? SYNC_BEGIN : ALT_ENTER),
        );
    const cutAt = [...cuts.keys()].sort((a, b) => a - b);
    type Entry = {
      start: number;
      end: number;
      cols: number;
      rows: number;
      time: number;
      flags: number;
    };
    const entries: Entry[] = [];
    let next = 0;
    for (const event of raw) {
      if (event.cols < 0) {
        entries.push({ ...event, cols: -event.cols, flags: 0 });
        continue;
      }
      let at = event.start;
      while (next < cutAt.length && cutAt[next]! < event.start) next++;
      while (next < cutAt.length && cutAt[next]! < event.end) {
        const cut = cutAt[next++]!;
        if (cut > at) entries.push({ ...event, start: at, end: cut, flags: 0 });
        at = cut;
      }
      entries.push({ ...event, start: at, end: event.end, flags: 0 });
    }
    for (const entry of entries)
      if (entry.end > entry.start) entry.flags = cuts.get(entry.start) ?? 0;
    // Pass three: typed arrays and the synchronized-update display map.
    const count = entries.length;
    const kind = new Uint8Array(count);
    const offset = new Uint32Array(count + 1);
    const cols16 = new Uint16Array(count);
    const rows16 = new Uint16Array(count);
    const time = new Float64Array(count);
    const flags = new Uint8Array(count);
    const display = new Uint32Array(count + 1);
    let mark = 0,
      held = false,
      holdFrom = 0,
      begin = 0;
    for (let i = 0; i < count; i++) {
      const entry = entries[i]!;
      kind[i] = entry.end > entry.start ? 0 : 1;
      offset[i + 1] = entry.end;
      cols16[i] = entry.cols;
      rows16[i] = entry.rows;
      time[i] = entry.time;
      flags[i] = entry.flags;
      const wasHeld = held;
      // The update begins where its sequence starts, possibly an earlier write.
      if (entry.flags & SYNC_BEGIN && !held) begin = i;
      while (mark < marks.length && marks[mark]!.end <= entry.end) {
        const type = marks[mark++]!.type;
        if (type === 'sync-on') held = true;
        else if (type === 'sync-off' || type === 'reset') held = false;
      }
      if (!held) holdFrom = i + 1;
      else if (!wasHeld) holdFrom = begin;
      display[i + 1] = holdFrom;
    }
    const duration = playback + compress(Math.max(0, recording.duration - source));
    return new Timeline(
      { cols: startCols, rows: startRows, bytes, kind, offset, cols16, rows16, time, flags },
      duration,
      markers,
      display,
    );
  }
  get count(): number {
    return this.kind.length;
  }
  /** The number of events at or before `seconds`: the state shown at that time. */
  indexAt(seconds: number): number {
    let low = 0,
      high = this.count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.time[mid]! <= seconds) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  /** Playback time at which the state after `index` events first shows. */
  timeOf(index: number): number {
    return index <= 0 ? 0 : (this.time[Math.min(index, this.count) - 1] ?? 0);
  }
  /** Grid size after `index` events. */
  sizeAt(index: number): [number, number] {
    return index <= 0 ? [this.cols, this.rows] : [this.cols16[index - 1]!, this.rows16[index - 1]!];
  }
  compact(): CompactTimeline {
    const { cols, rows, bytes, kind, offset, cols16, rows16, time, flags } = this;
    return { cols, rows, bytes, kind, offset, cols16, rows16, time, flags };
  }
}

/**
 * Conservative VT parser state, tracked so keyframes are only taken where
 * libghostty's parser is idle: outside escape sequences, control strings and
 * multibyte UTF-8. It also notes Kitty graphics (APC `G`), whose image storage
 * is not part of a VT snapshot.
 */
export class GroundTracker {
  private state = 0;
  private need = 0;
  private apcStart = false;
  graphics = false;
  get ground(): boolean {
    return this.state === 0 && this.need === 0;
  }
  feed(bytes: Uint8Array) {
    let state = this.state,
      need = this.need;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      if (byte === 0x18 || byte === 0x1a) {
        state = 0;
        need = 0;
        continue;
      }
      switch (state) {
        case 0: // ground
          if (byte === 0x1b) {
            state = 1;
            need = 0;
          } else if (byte < 0x80) need = 0;
          else if (byte < 0xc0) need = need > 0 ? need - 1 : 0;
          else need = byte >= 0xf0 ? 3 : byte >= 0xe0 ? 2 : 1;
          break;
        case 1: // ESC
          if (byte === 0x5b) state = 3;
          else if (byte === 0x5d) state = 4;
          else if (byte === 0x50 || byte === 0x58 || byte === 0x5e) state = 5;
          else if (byte === 0x5f) {
            state = 5;
            this.apcStart = true;
            continue;
          } else if (byte >= 0x20 && byte <= 0x2f) state = 2;
          else if (byte !== 0x1b) state = 0;
          break;
        case 2: // ESC intermediate
          if (byte === 0x1b) state = 1;
          else if (byte >= 0x30) state = 0;
          break;
        case 3: // CSI
          if (byte === 0x1b) state = 1;
          else if (byte >= 0x40 && byte <= 0x7e) state = 0;
          break;
        case 4: // OSC: BEL or ST
          if (byte === 0x07) state = 0;
          else if (byte === 0x1b) state = 6;
          break;
        case 5: // DCS, SOS, PM, APC: ST
          if (byte === 0x1b) state = 7;
          break;
        case 6: // ESC inside OSC
        case 7: // ESC inside another string
          if (byte === 0x5c) state = 0;
          else {
            state = 1;
            i--; // ESC aborts the string; reprocess this byte as an escape.
          }
          break;
      }
      if (this.apcStart) {
        this.apcStart = false;
        if (byte === 0x47) this.graphics = true;
      }
    }
    this.state = state;
    this.need = need;
  }
}

/** A restorable state: replaying `RESET + state` at `cols`×`rows` reproduces
 * the state after `index` events for every target index in [index, until). */
export interface Keyframe {
  index: number;
  until: number;
  cols: number;
  rows: number;
  state: Uint8Array;
}

/** The subset of the Wasm `Headless` class keyframes need. */
export interface HeadlessEngine {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  snapshot(): Uint8Array;
  digest(): string;
  mode(mode: number): boolean;
  free(): void;
}

export interface KeyframeOptions {
  /** Retained history lines; must equal the replaying terminal's scrollback. */
  history: number;
  /** Minimum output bytes between keyframes. Defaults to 256 KiB. The gap
   * also grows to twice the last snapshot's size, bounding keyframe memory. */
  interval?: number;
  /** Output bytes between digest checks of keyframes under verification.
   * Defaults to an eighth of the interval; 1 checks after every event. */
  sampleEvery?: number;
}

export type KeyframeMessage =
  { type: 'keyframe'; keyframe: Keyframe } | { type: 'extend'; index: number; until: number };

export interface KeyframeStats {
  candidates: number;
  verified: number;
  rejected: number;
  /** Candidates taken on the alternate screen, restored above the primary screen. */
  alternate: number;
  /** Keyframes skipped because Kitty graphics were in use. */
  graphics: boolean;
  stateBytes: number;
  samples: number;
  elapsedMs: number;
}

/** Grid digest of parsed content; libghostty reads it even inside a
 * synchronized update, without ending the update. */
const grid = (engine: HeadlessEngine) => engine.digest();

const alternate = (engine: HeadlessEngine) =>
  engine.mode(1049) || engine.mode(1047) || engine.mode(47);

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * Replay a timeline linearly and emit verified keyframes. `create` returns a
 * fresh engine. Runs synchronously; call it from a worker for long recordings.
 */
export function buildKeyframes(
  timeline: CompactTimeline,
  create: (cols: number, rows: number, history: number) => HeadlessEngine,
  options: KeyframeOptions,
  emit: (message: KeyframeMessage) => void,
): KeyframeStats {
  const started = performance.now();
  const interval = Math.max(4096, options.interval ?? 256 * 1024);
  const sampleEvery = Math.max(1, options.sampleEvery ?? interval / 8);
  const stats: KeyframeStats = {
    candidates: 0,
    verified: 0,
    rejected: 0,
    alternate: 0,
    graphics: false,
    stateBytes: 0,
    samples: 0,
    elapsedMs: 0,
  };
  type Verifier = { keyframe: Keyframe; engine: HeadlessEngine; ok: boolean; emitted: boolean };
  let live: Verifier[] = [];
  const linear = create(timeline.cols, timeline.rows, options.history);
  const tracker = new GroundTracker();
  let cols = timeline.cols,
    rows = timeline.rows;
  let sinceCandidate = 0,
    sinceSample = 0,
    lastState = 0;
  let primary: Uint8Array | undefined;
  const release = (verifier: Verifier) => {
    try {
      verifier.engine.free();
    } catch {
      // Already freed.
    }
  };
  const settle = (boundary: number, snapshot: Uint8Array, digest: string) => {
    for (const v of live) {
      if (!v.ok) continue;
      v.ok = grid(v.engine) === digest && equalBytes(v.engine.snapshot(), snapshot);
      if (!v.ok) {
        stats.rejected++;
        continue;
      }
      v.keyframe.until = boundary + 1;
      if (!v.emitted) {
        v.emitted = true;
        stats.verified++;
        stats.stateBytes += v.keyframe.state.byteLength;
        emit({ type: 'keyframe', keyframe: { ...v.keyframe } });
      } else emit({ type: 'extend', index: v.keyframe.index, until: v.keyframe.until });
    }
    // Keep only the newest verified engine: it extends over later candidates
    // until one of them verifies in turn.
    const keep = [...live].reverse().find((v) => v.ok);
    for (const v of live) if (v !== keep) release(v);
    live = keep ? [keep] : [];
  };
  try {
    const count = timeline.kind.length;
    for (let i = 0; i < count; i++) {
      if (timeline.kind[i] === 1) {
        cols = timeline.cols16[i]!;
        rows = timeline.rows16[i]!;
        // The primary screen reflows while hidden; its entry snapshot no longer applies.
        primary = undefined;
        linear.resize(cols, rows);
        for (const v of live) v.engine.resize(cols, rows);
      } else {
        const bytes = timeline.bytes.subarray(timeline.offset[i]!, timeline.offset[i + 1]!);
        // Snapshots cover the active screen only. Keep the primary screen as it
        // was when the alternate screen opened, to restore beneath alternate
        // keyframes; output cannot change it until the alternate screen closes.
        if (timeline.flags[i]! & ALT_ENTER && tracker.ground && !alternate(linear))
          primary = linear.snapshot();
        linear.write(bytes);
        for (const v of live) v.engine.write(bytes);
        tracker.feed(bytes);
        sinceCandidate += bytes.byteLength;
        sinceSample += bytes.byteLength;
      }
      const boundary = i + 1;
      if (sinceSample >= sampleEvery && live.some((v) => v.ok)) {
        sinceSample = 0;
        stats.samples++;
        const digest = grid(linear);
        for (const v of live)
          if (v.ok && grid(v.engine) !== digest) {
            v.ok = false;
            stats.rejected++;
          }
      }
      if (
        boundary < count &&
        sinceCandidate >= Math.max(interval, lastState * 2) &&
        tracker.ground &&
        !tracker.graphics &&
        !linear.mode(2026)
      ) {
        const beneath = alternate(linear) ? primary : new Uint8Array(0);
        if (!beneath) continue;
        sinceCandidate = 0;
        sinceSample = 0;
        const snapshot = linear.snapshot();
        const digest = grid(linear);
        settle(boundary, snapshot, digest);
        stats.candidates++;
        // The alternate snapshot's modes switch screens after the primary restores.
        const state = beneath.byteLength ? concatBytes(beneath, snapshot) : snapshot;
        if (beneath.byteLength) stats.alternate++;
        lastState = state.byteLength;
        const engine = create(cols, rows, options.history);
        engine.write(RESET);
        engine.write(state);
        const candidate: Verifier = {
          keyframe: { index: boundary, until: boundary, cols, rows, state },
          engine,
          ok: grid(engine) === digest && equalBytes(engine.snapshot(), snapshot),
          emitted: false,
        };
        if (candidate.ok) live.push(candidate);
        else {
          stats.rejected++;
          release(candidate);
        }
      }
    }
    if (live.length) settle(count, linear.snapshot(), grid(linear));
    stats.graphics = tracker.graphics;
  } finally {
    for (const v of live) release(v);
    linear.free();
  }
  stats.elapsedMs = performance.now() - started;
  return stats;
}

/** Where a seek applies its bytes. Writes may be asynchronous. */
export interface ReplayTarget {
  write(bytes: Uint8Array): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
}

export interface SeekResult {
  /** True when the terminal was reset and restored from a keyframe or the start. */
  restored: boolean;
  /** Event index of the keyframe restored, or -1. Zero is the start. */
  keyframe: number;
  /** Bytes written, including any keyframe state. */
  bytes: number;
}

/** Restoring costs a reset and repaint; prefer replaying a little more. */
const RESTORE_OVERHEAD = 16 * 1024;

/** Applies a timeline to a target, choosing keyframes for seeks. Not reentrant:
 * await each call before the next. */
export class ReplayCursor {
  /** Events applied to the target. */
  applied = -1;
  private keyframes: Keyframe[];
  private derived: Keyframe;
  constructor(
    readonly timeline: Timeline,
    private readonly target: ReplayTarget,
  ) {
    this.derived = {
      index: 0,
      until: Infinity,
      cols: timeline.cols,
      rows: timeline.rows,
      state: new Uint8Array(0),
    };
    this.keyframes = [this.derived];
  }
  /** Verified keyframes, including the start. */
  get available(): readonly Keyframe[] {
    return this.keyframes;
  }
  add(keyframe: Keyframe) {
    if (keyframe.index <= 0 || keyframe.index > this.timeline.count) return;
    const at = this.keyframes.findIndex((k) => k.index >= keyframe.index);
    if (at === -1) this.keyframes.push(keyframe);
    else if (this.keyframes[at]!.index === keyframe.index) this.keyframes[at] = keyframe;
    else this.keyframes.splice(at, 0, keyframe);
  }
  extend(index: number, until: number) {
    const keyframe = this.keyframes.find((k) => k.index === index);
    if (keyframe) keyframe.until = Math.max(keyframe.until, until);
  }
  /** The latest keyframe whose verified range contains `index`. */
  best(index: number): Keyframe {
    for (let i = this.keyframes.length - 1; i >= 0; i--) {
      const k = this.keyframes[i]!;
      if (k.index <= index && index < k.until) return k;
    }
    return this.keyframes[0]!;
  }
  /** Show the state after `index` events. */
  async seek(index: number): Promise<SeekResult> {
    const target = Math.max(0, Math.min(this.timeline.count, Math.floor(index)));
    const offset = this.timeline.offset;
    const keyframe = this.best(target);
    const forward =
      this.applied >= 0 && target >= this.applied && target < this.derived.until
        ? offset[target]! - offset[this.applied]!
        : Infinity;
    const restore = keyframe.state.byteLength + offset[target]! - offset[keyframe.index]!;
    if (forward <= restore + RESTORE_OVERHEAD) {
      await this.apply(this.applied, target);
      return { restored: false, keyframe: -1, bytes: forward };
    }
    await this.restore(keyframe, target);
    return { restored: true, keyframe: keyframe.index, bytes: restore + RESET.byteLength };
  }
  private async restore(keyframe: Keyframe, target: number) {
    const { kind, bytes, offset } = this.timeline;
    await this.target.resize(keyframe.cols, keyframe.rows);
    let end = keyframe.index;
    while (end < target && kind[end] === 0) end++;
    this.applied = -1;
    await this.target.write(
      concatBytes(RESET, keyframe.state, bytes.subarray(offset[keyframe.index]!, offset[end]!)),
    );
    this.derived = keyframe;
    this.applied = end;
    await this.apply(end, target);
  }
  private async apply(from: number, to: number) {
    const { kind, bytes, offset, cols16, rows16 } = this.timeline;
    let i = from;
    while (i < to) {
      let end = i;
      while (end < to && kind[end] === 0) end++;
      if (end > i) {
        await this.target.write(bytes.subarray(offset[i]!, offset[end]!));
        this.applied = i = end;
      }
      if (i < to && kind[i] === 1) {
        await this.target.resize(cols16[i]!, rows16[i]!);
        this.applied = ++i;
      }
    }
    this.applied = to;
  }
}
