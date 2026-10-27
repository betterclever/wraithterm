// Shared-session building blocks for `wraithterm serve --share` / `--record`.
//
// ModeTracker scans PTY output for the few pieces of terminal state that a
// fresh terminal needs to reproduce what came after (private modes, keypad,
// cursor style, title) and for full-screen resets. ReplayBuffer keeps a
// bounded log of output and owner resizes since the last reset so late joiners
// and resyncing clients see the current screen. AsciicastWriter emits an
// asciicast v2 recording.
import { StringDecoder } from 'node:string_decoder';

// DEC private modes a late joiner must inherit, with their power-on defaults.
// Alternate-screen modes are tracked separately.
const TRACKED_MODES = new Map([
  [1, false], // application cursor keys
  [5, false], // reverse video
  [6, false], // origin mode
  [7, true], // autowrap
  [12, false], // blinking cursor
  [25, true], // cursor visible
  [1000, false], // mouse: press/release
  [1002, false], // mouse: button motion
  [1003, false], // mouse: any motion
  [1004, false], // focus events
  [1005, false], // mouse: UTF-8 encoding
  [1006, false], // mouse: SGR encoding
  [1015, false], // mouse: urxvt encoding
  [1016, false], // mouse: SGR pixels
  [2004, false], // bracketed paste
]);
const ALT_MODES = new Set([47, 1047, 1049]);
const HOME = new Set(['', '1', '1;', ';', '1;1', ';1']);
const MAX_OSC = 4096;

const GROUND = 0,
  ESC = 1,
  ESC_INTER = 2,
  CSI = 3,
  OSC = 4,
  OSC_ESC = 5,
  STRING = 6,
  STRING_ESC = 7;

export class ModeTracker {
  constructor() {
    this.state = GROUND;
    this.params = '';
    this.inter = '';
    this.osc = '';
    this.home = false;
    this.version = 0;
    this.cached = { version: -1, value: '' };
    this.title = '';
    this.resetModes();
  }
  resetModes() {
    this.modes = new Map(TRACKED_MODES);
    this.alt = false;
    this.keypad = false;
    this.cursorStyle = '';
    this.version++;
  }
  /** The tracked state, shared between calls until it changes. */
  snapshot() {
    if (this.saved?.version !== this.version)
      this.saved = {
        version: this.version,
        modes: new Map(this.modes),
        alt: this.alt,
        keypad: this.keypad,
        cursorStyle: this.cursorStyle,
        title: this.title,
      };
    return this.saved;
  }
  static from(snapshot) {
    const tracker = new ModeTracker();
    if (snapshot) {
      tracker.modes = new Map(snapshot.modes);
      tracker.alt = snapshot.alt;
      tracker.keypad = snapshot.keypad;
      tracker.cursorStyle = snapshot.cursorStyle;
      tracker.title = snapshot.title;
      tracker.version++;
    }
    return tracker;
  }
  /** Escape sequences that bring a power-on terminal to the tracked state. */
  preamble({ includeAlt = true } = {}) {
    if (includeAlt && this.alt) return '\x1b[?1049h' + this.preamble({ includeAlt: false });
    if (this.cached.version === this.version) return this.cached.value;
    let out = '';
    for (const [mode, on] of this.modes)
      if (on !== TRACKED_MODES.get(mode)) out += `\x1b[?${mode}${on ? 'h' : 'l'}`;
    if (this.keypad) out += '\x1b=';
    if (this.cursorStyle) out += `\x1b[${this.cursorStyle} q`;
    if (this.title) out += `\x1b]2;${this.title}\x07`;
    this.cached = { version: this.version, value: out };
    return out;
  }
  /**
   * Scan one chunk. Calls `onReset(end)` after each full reset (RIS, or cursor
   * home followed by erase display outside the alternate screen), where `end`
   * is the chunk offset just past the resetting sequence.
   */
  scan(chunk, onReset) {
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      switch (this.state) {
        case GROUND:
          if (byte === 0x1b) this.state = ESC;
          else this.home = false;
          break;
        case ESC:
          this.state = GROUND;
          if (byte === 0x5b) {
            this.state = CSI;
            this.params = '';
            this.inter = '';
          } else if (byte === 0x5d) {
            this.state = OSC;
            this.osc = '';
          } else if (byte === 0x50 || byte === 0x5f || byte === 0x5e || byte === 0x58) {
            this.state = STRING; // DCS, APC (Kitty graphics), PM, SOS
            this.home = false;
          } else if (byte >= 0x20 && byte <= 0x2f) {
            this.state = ESC_INTER;
            this.home = false;
          } else if (byte === 0x1b) this.state = ESC;
          else {
            this.home = false;
            if (byte === 0x63) {
              this.resetModes();
              onReset?.(i + 1, true);
            } else if (byte === 0x3d) this.setKeypad(true);
            else if (byte === 0x3e) this.setKeypad(false);
          }
          break;
        case ESC_INTER:
          if (byte >= 0x30 && byte <= 0x7e) this.state = GROUND;
          else if (byte === 0x1b) this.state = ESC;
          else if (byte < 0x20 || byte > 0x2f) this.state = GROUND;
          break;
        case CSI:
          if (byte >= 0x30 && byte <= 0x3f) {
            if (this.params.length < 64) this.params += String.fromCharCode(byte);
          } else if (byte >= 0x20 && byte <= 0x2f) {
            if (this.inter.length < 4) this.inter += String.fromCharCode(byte);
          } else if (byte >= 0x40 && byte <= 0x7e) {
            this.state = GROUND;
            this.csi(String.fromCharCode(byte), i, onReset);
          } else if (byte === 0x1b) this.state = ESC;
          else if (byte === 0x18 || byte === 0x1a) this.state = GROUND;
          break;
        case OSC:
          if (byte === 0x07) this.endOsc();
          else if (byte === 0x1b) this.state = OSC_ESC;
          else if (byte === 0x18 || byte === 0x1a) this.state = GROUND;
          else if (this.osc.length <= MAX_OSC) this.osc += String.fromCharCode(byte);
          break;
        case OSC_ESC:
          if (byte === 0x5c) this.endOsc();
          else {
            this.state = ESC;
            i--;
          }
          break;
        case STRING:
          if (byte === 0x1b) this.state = STRING_ESC;
          else if (byte === 0x18 || byte === 0x1a) this.state = GROUND;
          break;
        case STRING_ESC:
          if (byte === 0x5c) this.state = GROUND;
          else if (byte !== 0x1b) this.state = STRING;
          break;
      }
    }
  }
  setKeypad(on) {
    if (this.keypad !== on) {
      this.keypad = on;
      this.version++;
    }
  }
  endOsc() {
    this.state = GROUND;
    this.home = false;
    // OSC bytes are UTF-8; Latin-1 accumulation round-trips them losslessly.
    const text = Buffer.from(this.osc, 'latin1').toString('utf8');
    const match = /^([02]);(.*)$/s.exec(text);
    if (match && this.osc.length <= MAX_OSC && this.title !== match[2]) {
      this.title = match[2];
      this.version++;
    }
  }
  csi(final, index, onReset) {
    const { params, inter } = this;
    const wasHome = this.home;
    this.home = false;
    if (!inter && (final === 'H' || final === 'f')) {
      this.home = HOME.has(params);
      return;
    }
    if (!inter && final === 'J' && (params === '2' || params === '3')) {
      if (wasHome && params === '2' && !this.alt) onReset?.(index + 1, false);
      else if (wasHome) this.home = true;
      return;
    }
    if (inter === ' ' && final === 'q') {
      const style = /^\d*$/.test(params) && params !== '0' ? params : '';
      if (style !== this.cursorStyle) {
        this.cursorStyle = style;
        this.version++;
      }
      return;
    }
    if (inter || params[0] !== '?' || (final !== 'h' && final !== 'l')) return;
    const on = final === 'h';
    for (const part of params.slice(1).split(';')) {
      const mode = Number(part);
      if (ALT_MODES.has(mode)) {
        if (this.alt !== on) {
          this.alt = on;
          this.version++;
        }
      } else if (this.modes.has(mode) && this.modes.get(mode) !== on) {
        this.modes.set(mode, on);
        this.version++;
      }
    }
  }
}

const BLOCK = 64 * 1024;

/**
 * Output since the last full reset, plus owner resizes, bounded to `limit`
 * bytes. When it overflows, the oldest output is dropped and replay starts at a
 * line boundary with the modes in effect there: best effort, unlike the exact
 * replay after a reset.
 */
export class ReplayBuffer {
  constructor({ limit = 2 * 1024 * 1024, cols = 80, rows = 24 } = {}) {
    this.limit = limit;
    this.tracker = new ModeTracker();
    this.start = { cols, rows, state: undefined };
    this.cols = cols;
    this.rows = rows;
    this.entries = [];
    this.bytes = 0;
    this.resets = 0;
    this.truncated = false;
  }
  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.entries.push({ size: [cols, rows] });
  }
  write(chunk) {
    const state = this.tracker.snapshot();
    let reset = -1,
      ris = false,
      resetModes = '';
    this.tracker.scan(chunk, (end, isRis) => {
      reset = end;
      ris = isRis;
      resetModes = this.tracker.preamble({ includeAlt: false });
    });
    if (reset >= 0) {
      this.entries = [];
      this.bytes = 0;
      this.resets++;
      this.truncated = false;
      this.start = { cols: this.cols, rows: this.rows, state: undefined };
      const lead = Buffer.from(resetModes + (ris ? '' : '\x1b[H\x1b[2J'), 'utf8');
      this.append(Buffer.concat([lead, chunk.subarray(reset)]), undefined);
    } else this.append(chunk, state);
    this.trim();
  }
  // Entries are `{ size }` or `{ buf, start, end, state }`, where `state` is the
  // tracked state before `buf[start]`. Small writes share 64 KiB blocks.
  append(chunk, state) {
    if (!chunk.length) return;
    this.bytes += chunk.length;
    const last = this.entries.at(-1);
    if (last?.buf && last.end + chunk.length <= last.buf.length) {
      chunk.copy(last.buf, last.end);
      last.end += chunk.length;
    } else if (chunk.length >= BLOCK / 4) {
      this.entries.push({ buf: chunk, start: 0, end: chunk.length, state });
    } else {
      const buf = Buffer.allocUnsafe(BLOCK);
      chunk.copy(buf);
      this.entries.push({ buf, start: 0, end: chunk.length, state });
    }
  }
  trim() {
    if (this.bytes <= this.limit) return;
    this.truncated = true;
    while (this.bytes > this.limit && this.entries.length) {
      const first = this.entries[0];
      if (first.size) {
        [this.start.cols, this.start.rows] = first.size;
        this.entries.shift();
        continue;
      }
      const excess = this.bytes - this.limit;
      if (first.end - first.start <= excess) {
        this.bytes -= first.end - first.start;
        this.entries.shift();
        continue;
      }
      // Drop the head of this entry and resume after the next line break so
      // replay does not start inside an escape sequence or UTF-8 character.
      let cut = first.start + excess;
      const newline = first.buf.subarray(0, first.end).indexOf(0x0a, cut);
      if (newline >= 0 && newline - cut < 4096) cut = newline + 1;
      // Rescan the dropped head so the kept part starts with its own state.
      const scratch = ModeTracker.from(first.state);
      scratch.scan(first.buf.subarray(first.start, cut));
      first.state = scratch.snapshot();
      this.bytes -= cut - first.start;
      first.start = cut;
      break;
    }
    const head = this.entries.find((entry) => entry.buf);
    this.start.state = head ? head.state : this.tracker.snapshot();
  }
  /** Messages that rebuild the current screen on a fresh terminal, in order. */
  snapshot() {
    const items = [{ size: [this.start.cols, this.start.rows] }];
    const modes = this.start.state ? ModeTracker.from(this.start.state).preamble() : '';
    if (modes) items.push(Buffer.from(modes, 'utf8'));
    for (const entry of this.entries)
      items.push(entry.size ? { size: entry.size } : entry.buf.subarray(entry.start, entry.end));
    return items;
  }
}

/** asciicast v2: a JSON header line, then `[seconds, code, data]` event lines. */
export class AsciicastWriter {
  constructor(stream, { cols, rows, env = {}, now = () => performance.now() } = {}) {
    this.stream = stream;
    this.now = now;
    this.origin = now();
    this.decoder = new StringDecoder('utf8');
    const header = {
      version: 2,
      width: cols,
      height: rows,
      timestamp: Math.floor(Date.now() / 1000),
      env,
    };
    stream.write(JSON.stringify(header) + '\n');
  }
  time() {
    return Math.round((this.now() - this.origin) * 1000) / 1e6;
  }
  output(chunk) {
    const text = this.decoder.write(chunk);
    if (text) this.stream.write(JSON.stringify([this.time(), 'o', text]) + '\n');
  }
  resize(cols, rows) {
    this.stream.write(JSON.stringify([this.time(), 'r', `${cols}x${rows}`]) + '\n');
  }
  close() {
    const text = this.decoder.end();
    if (text) this.stream.write(JSON.stringify([this.time(), 'o', text]) + '\n');
    return new Promise((done) => this.stream.end(done));
  }
}
