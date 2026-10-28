/**
 * Terminal session recordings: a recorder for live terminals and asciicast
 * (asciinema `.cast`) import and export. Times are seconds from the start.
 */
import type { Disposable } from './types.js';

export type RecordingEvent =
  /** Bytes the terminal parsed (program output). */
  | { time: number; type: 'output'; data: Uint8Array }
  /** Keyboard input the user typed; replay does not feed it to the terminal. */
  | { time: number; type: 'input'; data: string }
  /** The terminal grid changed size. */
  | { time: number; type: 'resize'; cols: number; rows: number }
  /** A named point, such as a chapter, shown on the player's timeline. */
  | { time: number; type: 'marker'; label: string };

export interface RecordingTheme {
  /** `#rrggbb`. */
  foreground: string;
  /** `#rrggbb`. */
  background: string;
  /** Eight or sixteen `#rrggbb` colours for palette entries 0–15. */
  palette: string[];
}

export interface Recording {
  /** Grid size when the recording starts. */
  cols: number;
  rows: number;
  /** Seconds; at least the time of the last event. */
  duration: number;
  /** Events in non-decreasing time order. */
  events: RecordingEvent[];
  /** Unix time in seconds when recording began. */
  timestamp?: number;
  title?: string;
  command?: string;
  /** Pauses longer than this many seconds are shortened to it on playback. */
  idleTimeLimit?: number;
  env?: Record<string, string>;
  theme?: RecordingTheme;
}

export interface RecorderOptions {
  cols: number;
  rows: number;
  title?: string;
  command?: string;
  env?: Record<string, string>;
  theme?: RecordingTheme;
  idleTimeLimit?: number;
  /** Clock in milliseconds. Defaults to `performance.now()`. */
  now?: () => number;
}

/**
 * Captures output, input, resizes and markers with timestamps. Feed it
 * yourself, or use `Wraith#record()` to attach it to a native terminal.
 */
export class WraithRecorder {
  private events: RecordingEvent[] = [];
  private readonly started: number;
  private readonly clock: () => number;
  private readonly header: Omit<Recording, 'events' | 'duration'>;
  private stopped?: Recording;
  private stopListeners = new Set<() => void>();
  constructor(options: RecorderOptions) {
    validateSize(options.cols, options.rows);
    this.clock = options.now ?? (() => performance.now());
    this.started = this.clock();
    this.header = {
      cols: options.cols,
      rows: options.rows,
      timestamp: Math.floor(Date.now() / 1000),
      ...(options.title !== undefined && { title: options.title }),
      ...(options.command !== undefined && { command: options.command }),
      ...(options.env !== undefined && { env: { ...options.env } }),
      ...(options.theme !== undefined && { theme: options.theme }),
      ...(options.idleTimeLimit !== undefined && { idleTimeLimit: options.idleTimeLimit }),
    };
  }
  /** True until `stop()`. */
  get recording(): boolean {
    return !this.stopped;
  }
  /** Seconds since recording began. */
  get elapsed(): number {
    return Math.max(0, (this.clock() - this.started) / 1000);
  }
  /** Bytes or text the terminal parsed. The recorder keeps its own copy. */
  output(data: string | Uint8Array): void {
    if (this.stopped) return;
    const bytes = typeof data === 'string' ? encoder.encode(data) : data.slice();
    if (bytes.byteLength) this.events.push({ time: this.elapsed, type: 'output', data: bytes });
  }
  input(data: string): void {
    if (this.stopped || !data) return;
    this.events.push({ time: this.elapsed, type: 'input', data });
  }
  resize(cols: number, rows: number): void {
    if (this.stopped) return;
    validateSize(cols, rows);
    this.events.push({ time: this.elapsed, type: 'resize', cols, rows });
  }
  marker(label = ''): void {
    if (this.stopped) return;
    this.events.push({ time: this.elapsed, type: 'marker', label });
  }
  /** Stop capturing and return the recording. Later calls return the same one. */
  stop(): Recording {
    if (this.stopped) return this.stopped;
    const duration = this.elapsed;
    this.stopped = { ...this.header, duration, events: this.events };
    for (const listener of this.stopListeners) listener();
    this.stopListeners.clear();
    return this.stopped;
  }
  /** @internal Runs once when the recorder stops. */
  onStop(listener: () => void): Disposable {
    this.stopListeners.add(listener);
    return { dispose: () => this.stopListeners.delete(listener) };
  }
}

const encoder = new TextEncoder();

function validateSize(cols: number, rows: number) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1)
    throw new RangeError(`Invalid terminal size ${cols}x${rows}`);
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new SyntaxError(`asciicast: ${what} must be a finite number`);
  return value;
}

const HEX = /^#[\da-f]{6}$/i;
function parseTheme(theme: unknown): RecordingTheme | undefined {
  if (!theme || typeof theme !== 'object') return undefined;
  const { fg, bg, palette } = theme as { fg?: unknown; bg?: unknown; palette?: unknown };
  if (typeof fg !== 'string' || typeof bg !== 'string' || typeof palette !== 'string')
    return undefined;
  const colors = palette.split(':');
  if (![fg, bg, ...colors].every((c) => HEX.test(c)) || ![8, 16].includes(colors.length))
    return undefined;
  return { foreground: fg, background: bg, palette: colors };
}
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value).filter(([, v]) => typeof v === 'string');
  return Object.fromEntries(entries) as Record<string, string>;
}
function parseSize(data: string): [number, number] {
  const match = /^(\d+)x(\d+)$/.exec(data);
  if (!match) throw new SyntaxError(`asciicast: invalid resize "${data}"`);
  return [Number(match[1]), Number(match[2])];
}

/**
 * Parse an asciicast recording: v2 and v3 newline-delimited JSON, or the
 * original v1 JSON document. Output text is UTF-8 encoded. Unknown event
 * codes are ignored; v3 exit events become markers.
 */
export function parseAsciicast(text: string): Recording {
  const source = text.replace(/^﻿/, '');
  const newline = source.indexOf('\n');
  const firstLine = newline === -1 ? source : source.slice(0, newline);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(firstLine);
  } catch {
    // A v1 document may be pretty-printed over several lines.
    try {
      header = JSON.parse(source);
    } catch {
      throw new SyntaxError('asciicast: the first line is not a JSON header');
    }
  }
  if (!header || typeof header !== 'object' || Array.isArray(header))
    throw new SyntaxError('asciicast: missing header object');
  const version = header.version;
  if (version === 1) return parseV1(header);
  if (version !== 2 && version !== 3)
    throw new SyntaxError(`asciicast: unsupported version ${String(version)}`);
  const term = (version === 3 ? header.term : header) as Record<string, unknown> | undefined;
  const cols = finite(version === 3 ? term?.cols : header.width, 'width');
  const rows = finite(version === 3 ? term?.rows : header.height, 'height');
  validateSize(cols, rows);
  const recording: Recording = { cols, rows, duration: 0, events: [] };
  if (typeof header.timestamp === 'number') recording.timestamp = header.timestamp;
  if (typeof header.title === 'string') recording.title = header.title;
  if (typeof header.command === 'string') recording.command = header.command;
  if (typeof header.idle_time_limit === 'number' && header.idle_time_limit > 0)
    recording.idleTimeLimit = header.idle_time_limit;
  const env = stringRecord(header.env);
  if (env) recording.env = env;
  const theme = parseTheme(version === 3 ? term?.theme : header.theme);
  if (theme) recording.theme = theme;
  let time = 0;
  let lineNumber = 1;
  let start = newline === -1 ? source.length : newline + 1;
  while (start < source.length) {
    let end = source.indexOf('\n', start);
    if (end === -1) end = source.length;
    lineNumber++;
    const line = source.slice(start, end).trim();
    start = end + 1;
    if (!line || (version === 3 && line.startsWith('#'))) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new SyntaxError(`asciicast: line ${lineNumber} is not JSON`);
    }
    if (!Array.isArray(entry) || entry.length < 3 || typeof entry[1] !== 'string')
      throw new SyntaxError(`asciicast: line ${lineNumber} is not an event`);
    const stamp = finite(entry[0], `line ${lineNumber} time`);
    // v2 times are absolute; v3 stores the interval since the previous event.
    time = version === 3 ? time + Math.max(0, stamp) : Math.max(time, stamp);
    const code = entry[1];
    const data = typeof entry[2] === 'string' ? entry[2] : String(entry[2]);
    if (code === 'o') {
      if (data) recording.events.push({ time, type: 'output', data: encoder.encode(data) });
    } else if (code === 'i') recording.events.push({ time, type: 'input', data });
    else if (code === 'r') {
      const [c, r] = parseSize(data);
      validateSize(c, r);
      recording.events.push({ time, type: 'resize', cols: c, rows: r });
    } else if (code === 'm') recording.events.push({ time, type: 'marker', label: data });
    else if (code === 'x') recording.events.push({ time, type: 'marker', label: `exit ${data}` });
  }
  recording.duration = Math.max(
    time,
    typeof header.duration === 'number' && Number.isFinite(header.duration) ? header.duration : 0,
  );
  return recording;
}

function parseV1(header: Record<string, unknown>): Recording {
  const cols = finite(header.width, 'width');
  const rows = finite(header.height, 'height');
  validateSize(cols, rows);
  if (!Array.isArray(header.stdout)) throw new SyntaxError('asciicast: v1 stdout must be an array');
  const recording: Recording = { cols, rows, duration: 0, events: [] };
  if (typeof header.title === 'string') recording.title = header.title;
  if (typeof header.command === 'string') recording.command = header.command;
  const env = stringRecord(header.env);
  if (env) recording.env = env;
  let time = 0;
  for (const frame of header.stdout) {
    if (!Array.isArray(frame) || typeof frame[1] !== 'string') continue;
    time += Math.max(0, finite(frame[0], 'v1 frame delay'));
    if (frame[1]) recording.events.push({ time, type: 'output', data: encoder.encode(frame[1]) });
  }
  recording.duration = Math.max(time, typeof header.duration === 'number' ? header.duration : 0);
  return recording;
}

const round = (seconds: number) => Math.round(seconds * 1e6) / 1e6;

export interface AsciicastOptions {
  /** asciicast format version to write. Defaults to 2. */
  version?: 2 | 3;
}

/**
 * Serialize a recording as asciicast. Output bytes are decoded as streaming
 * UTF-8: a character split across writes moves to the event completing it,
 * and invalid bytes become U+FFFD, as asciicast stores text.
 */
export function toAsciicast(recording: Recording, options: AsciicastOptions = {}): string {
  const version = options.version ?? 2;
  const header: Record<string, unknown> = { version };
  const theme = recording.theme && {
    fg: recording.theme.foreground,
    bg: recording.theme.background,
    palette: recording.theme.palette.join(':'),
  };
  if (version === 3) {
    header.term = { cols: recording.cols, rows: recording.rows, ...(theme && { theme }) };
  } else {
    header.width = recording.cols;
    header.height = recording.rows;
  }
  if (recording.timestamp !== undefined) header.timestamp = recording.timestamp;
  if (version === 2) header.duration = round(recording.duration);
  if (recording.idleTimeLimit !== undefined) header.idle_time_limit = recording.idleTimeLimit;
  if (recording.command !== undefined) header.command = recording.command;
  if (recording.title !== undefined) header.title = recording.title;
  if (recording.env !== undefined) header.env = recording.env;
  if (version === 2 && theme) header.theme = theme;
  const lines = [JSON.stringify(header)];
  const decoder = new TextDecoder();
  let previous = 0;
  const push = (time: number, code: string, data: string) => {
    const stamp = version === 3 ? round(time) - round(previous) : round(time);
    previous = time;
    lines.push(JSON.stringify([round(Math.max(0, stamp)), code, data]));
  };
  for (const event of recording.events) {
    if (event.type === 'output') {
      const text = decoder.decode(event.data, { stream: true });
      if (text) push(event.time, 'o', text);
    } else {
      // A partial character stays pending until the output that completes it.
      if (event.type === 'input') push(event.time, 'i', event.data);
      else if (event.type === 'resize') push(event.time, 'r', `${event.cols}x${event.rows}`);
      else push(event.time, 'm', event.label);
    }
  }
  const tail = decoder.decode();
  if (tail) push(recording.events.at(-1)?.time ?? 0, 'o', tail);
  return lines.join('\n') + '\n';
}

/** A recording, asciicast text, or a URL/Blob/bytes holding asciicast. */
export type RecordingSource = Recording | string | URL | Blob | ArrayBuffer | Uint8Array;

/**
 * Resolve a recording source. A string is asciicast text when it starts with
 * `{` (after whitespace), otherwise a URL to fetch.
 */
export async function loadRecording(source: RecordingSource): Promise<Recording> {
  if (source instanceof URL || (typeof source === 'string' && !/^\s*\{/.test(source))) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Recording request failed: ${response.status}`);
    return parseAsciicast(await response.text());
  }
  if (typeof source === 'string') return parseAsciicast(source);
  if (source instanceof Blob) return parseAsciicast(await source.text());
  if (source instanceof ArrayBuffer || source instanceof Uint8Array)
    return parseAsciicast(new TextDecoder().decode(source));
  return source;
}
