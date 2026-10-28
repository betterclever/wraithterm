// Deterministic synthetic terminal sessions for replay tests and seek benchmarks.
// A session mixes shell typing, coloured build logs, carriage-return progress
// bars, full-screen alternate-screen apps with background-coloured rows,
// scrolling regions and synchronized output, Unicode, clears and resizes.
// Output is split at arbitrary byte offsets, including inside escape
// sequences and multibyte characters, as a PTY would deliver it.

export function rng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const words =
  'build module render atlas glyph shader worker parse frame cursor scroll buffer layout commit cache'.split(
    ' ',
  );
const unicode = ['界', 'é', 'e\u0301', '✓', '→', '█', '░', '日本語', 'Ω', '🙂'];

/**
 * @param {{ seconds?: number, seed?: number, cols?: number, rows?: number, scale?: number }} options
 * `scale` multiplies burst sizes; ~1 produces about 0.6 MB per simulated minute.
 * @returns {{ cols: number, rows: number, duration: number, events: Array<{time:number,type:string,data?:Uint8Array,cols?:number,rows?:number,label?:string}> }}
 */
export function generateSession(options = {}) {
  const random = rng(options.seed ?? 1);
  const seconds = options.seconds ?? 60;
  const scale = options.scale ?? 1;
  let cols = options.cols ?? 100,
    rows = options.rows ?? 30;
  const encoder = new TextEncoder();
  const events = [];
  let time = 0;
  const pick = (list) => list[Math.floor(random() * list.length)];
  const int = (n) => Math.floor(random() * n);
  // Deliver text as PTY reads: arbitrary byte splits.
  const emit = (text, spread = 0.05) => {
    const bytes = encoder.encode(text);
    let at = 0;
    while (at < bytes.length) {
      const size = Math.min(bytes.length - at, 1 + int(random() < 0.3 ? 64 : 4096));
      time += random() * spread;
      events.push({ time, type: 'output', data: bytes.slice(at, at + size) });
      at += size;
    }
  };
  const prompt = () => `\x1b[1;32muser@wraith\x1b[0m:\x1b[1;34m~/project\x1b[0m$ `;
  const type = (command) => {
    emit(prompt(), 0.01);
    for (const char of command) {
      time += 0.04 + random() * 0.12;
      events.push({ time, type: 'output', data: encoder.encode(char) });
    }
    emit('\r\n', 0.01);
  };
  const logs = () => {
    type(`npm run ${pick(words)}`);
    const count = Math.ceil((50 + int(400)) * scale);
    let text = '';
    for (let n = 0; n < count; n++) {
      const level = pick(['\x1b[32minfo\x1b[0m', '\x1b[33mwarn\x1b[0m', '\x1b[31merror\x1b[0m']);
      const extra = random() < 0.1 ? ` ${pick(unicode)}` : '';
      text += `${level} [${String(n).padStart(5)}] ${pick(words)} ${pick(words)} ${'·'.repeat(int(cols))}${extra}\r\n`;
      if (text.length > 2048) {
        emit(text, 0.02);
        text = '';
      }
    }
    emit(text);
  };
  const progress = () => {
    type(`cargo build --release`);
    for (let p = 0; p <= 100; p += 1 + int(7)) {
      const width = Math.max(10, cols - 20);
      const filled = Math.round((p / 100) * width);
      emit(
        `\r\x1b[36m[${'='.repeat(filled)}${' '.repeat(width - filled)}]\x1b[0m ${p}%\x1b[K`,
        0.08,
      );
    }
    emit('\r\n\x1b[1mFinished\x1b[0m release target\r\n');
  };
  const fullscreen = () => {
    type(pick(['vim src/main.rs', 'htop', 'less README.md']));
    emit('\x1b[?1049h\x1b[?25l');
    const frames = Math.ceil((20 + int(60)) * scale);
    for (let f = 0; f < frames; f++) {
      let frame = random() < 0.5 ? '\x1b[?2026h' : '';
      frame += '\x1b[H';
      for (let y = 0; y < rows - 1; y++) {
        const bg = 16 + ((y + f) % 200);
        frame += `\x1b[${y + 1};1H\x1b[48;5;${bg}m`;
        if (random() < 0.3) frame += '\x1b[K';
        else
          frame += `\x1b[38;5;${(y * 7 + f) % 256}m${String(y + f).padStart(4)} ${pick(words)} ${pick(unicode)} ${'x'.repeat(int(cols / 2))}\x1b[K`;
      }
      frame += `\x1b[${rows};1H\x1b[0;7m -- ${pick(words).toUpperCase()} -- ${f} \x1b[0m\x1b[K`;
      if (random() < 0.3) frame += `\x1b[2;${rows - 2}r\x1b[${rows - 2};1H\r\n\x1b[r`;
      if (frame.startsWith('\x1b[?2026h')) frame += '\x1b[?2026l';
      emit(frame, 0.1);
    }
    emit('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  const clear = () => {
    type('clear');
    emit('\x1b[H\x1b[2J\x1b[3J');
  };
  const misc = () => {
    type('echo "unicode"');
    emit(
      `${unicode.join(' ')} \x1b]0;title ${int(1000)}\x07\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\x1b(0lqqk\x1b(B\r\n`,
    );
  };
  const resize = () => {
    cols = 60 + int(80);
    rows = 16 + int(30);
    time += 0.2 + random();
    events.push({ time, type: 'resize', cols, rows });
  };
  const scenes = [logs, logs, progress, fullscreen, fullscreen, clear, misc, resize];
  let chapter = 0;
  while (time < seconds) {
    if (random() < 0.08) events.push({ time, type: 'marker', label: `chapter ${++chapter}` });
    pick(scenes)();
    time += random() * 1.5;
  }
  return { cols: options.cols ?? 100, rows: options.rows ?? 30, duration: time, events };
}
