// Resource-efficiency harness: one renderer (or none, for the baseline) per
// fresh browser, driven through one workload. The runner
// (scripts/efficiency-benchmark.mjs) reads CPU time, memory and GPU time per
// Chrome process around begin()/end() and subtracts the same run with
// type 'none': the same page, fonts and generated data, with a sink that
// discards writes instead of a terminal.
//
// All workload data is generated deterministically before the measured window,
// so generation is not in the measured CPU. Paced workloads skip a tick for a
// terminal whose previous write has not been accepted yet and count the skip.
import { Terminal as Xterm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { WTerm } from '@wterm/dom';
import { GhosttyCore } from '@wterm/ghostty';
import ghosttyWasm from '@wterm/ghostty/ghostty-vt.wasm?url';
import { init as ghosttyWebInit, Terminal as GhosttyWeb } from 'ghostty-web';
import { Terminal as ResttyTerm } from 'restty/xterm';
import { Terminal as ZemTerm } from '@zem-sh/terminal';
import '@wterm/dom/css';
import '@xterm/xterm/css/xterm.css';
import '../packages/wraith/css/xterm.css';
import { Wraith } from '../packages/wraith/dist/index.js';
import { Terminal as WraithXterm } from '../packages/wraith/dist/xterm.js';

const FONT_URL = '/fonts/JetBrainsMono-Regular.ttf';
const FONT_FAMILY = 'JetBrains Mono, monospace';
const MARKER = 'EFFICIENCY-END';
const enc = new TextEncoder();
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
const macrotask = () =>
  new Promise((r) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => r();
    c.port2.postMessage(0);
  });

export const SINGLE = { cols: 160, rows: 50, font: 13 };
export const WORKLOADS = {
  idle: { kind: 'window', seconds: 30 },
  scroll10k: { kind: 'window', seconds: 10, lines: 10_000 },
  scroll100k: { kind: 'window', seconds: 10, lines: 100_000 },
  typing: { kind: 'window', seconds: 30, intervalMs: 100 },
  logs: { kind: 'window', seconds: 20, intervalMs: 50, linesPerTick: 10 },
  throughput: { kind: 'work', bytes: 20 * 2 ** 20, timeoutS: 240 },
  dense: { kind: 'window', seconds: 20 },
  unicode: { kind: 'work', bytes: 8 * 2 ** 20, timeoutS: 240 },
  multi16: { kind: 'window', seconds: 20, terminals: 16, intervalMs: 100 },
  multi64: { kind: 'window', seconds: 20, terminals: 64, intervalMs: 100 },
};

// ---------------------------------------------------------------- workload data
let seed = 1;
const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const LEVELS = [
  '\x1b[32mINFO \x1b[0m',
  '\x1b[36mDEBUG\x1b[0m',
  '\x1b[33mWARN \x1b[0m',
  '\x1b[1;31mERROR\x1b[0m',
];
const WORDS =
  'request handled cache miss upstream retry worker queue flushed shard compacted snapshot lease renewed'.split(
    ' ',
  );
/** One colored ASCII log line, ~120 columns. */
function logLine(i) {
  const t = `2026-10-28T12:${String(((i / 60000) % 60) | 0).padStart(2, '0')}:${String(((i / 1000) % 60) | 0).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`;
  const r = ((i * 37) % 200) + 55,
    g = ((i * 91) % 200) + 55,
    b = ((i * 53) % 200) + 55;
  let msg = '';
  for (let k = 0; k < 8; k++) msg += WORDS[(i * 7 + k * 3) % WORDS.length] + ' ';
  return `\x1b[2m${t}\x1b[0m ${LEVELS[i % 4]} \x1b[38;2;${r};${g};${b}msvc-${i % 23}\x1b[0m ${msg}id=${i} latency=${(i * 7919) % 997}ms`;
}
const UNICODE = [
  '日本語のテキストを表示します。漢字、ひらがな、カタカナ。',
  '中文字符测试：终端渲染器需要正确处理宽字符。',
  '한국어 텍스트 렌더링 테스트입니다.',
  'emoji 😀 🚀 🔥 ✅ ❌ 🎉 👍🏽 👩‍💻 🧑‍🚀 🇯🇵 🇮🇳 🏳️‍🌈',
  'combining: e\u0301 a\u0308 n\u0303 o\u0302 — Ελληνικά, Кириллица, עברית',
  'box ┌──┬──┐ │▓▒░│ └──┴──┘ ⣿⣶⣤ ▁▂▃▄▅▆▇█ ←↑→↓ ∑∫√∞≠≈',
];
function unicodeLine(i) {
  const c = 31 + (i % 7);
  return `\x1b[${c}m${String(i).padStart(6, '0')}\x1b[0m ${UNICODE[i % UNICODE.length]} ${UNICODE[(i + 3) % UNICODE.length].slice(0, 16)}`;
}
/** Chunks of whole lines totalling at least `bytes` UTF-8 bytes. */
function corpus(lineFn, bytes, chunkBytes = 64 * 1024) {
  const chunks = [];
  let chunk = '',
    chunkLen = 0,
    total = 0,
    lines = 0;
  for (let i = 0; total < bytes; i++) {
    const line = lineFn(i) + '\r\n';
    const n = enc.encode(line).length;
    chunk += line;
    chunkLen += n;
    total += n;
    lines++;
    if (chunkLen >= chunkBytes) (chunks.push(chunk), (chunk = ''), (chunkLen = 0));
  }
  if (chunk) chunks.push(chunk);
  return { chunks, bytes: total, lines };
}
/** btop-like full-screen frame: every cell repainted, truecolor fg and bg. */
function denseFrame(f, cols, rows) {
  let s = '\x1b[?25l\x1b[H';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x += 8) {
      const v = (x * 3 + y * 5 + f * 7) % 256;
      const bar = ((x + f * 2 + y) % 40) / 5;
      s += `\x1b[48;2;${v};${(v * 3) % 256};${255 - v}m\x1b[38;2;${255 - v};${(y * 9) % 256};${v}m`;
      s += (bar > 4 ? '█▇▆▅' : '▁▂▃▄') + String((v * 13 + f) % 10000).padStart(4, '0');
    }
    s += '\x1b[0m' + (y < rows - 1 ? '\r\n' : '');
  }
  return s;
}
function logUpdate(id, n) {
  const levels = [
    '\x1b[38;2;143;184;255m● Read',
    '\x1b[38;2;142;224;160m  ✓',
    '\x1b[38;2;255;204;102m  ↻',
    '\x1b[38;2;232;224;214m   ',
  ];
  let out = '';
  for (let k = 0; k < 2; k++)
    out += `\r\n${levels[(n + k) % 4]}\x1b[0m agent-${id} step ${n * 2 + k} · src/module-${(n + k) % 37}.ts · ${(n * 7919) % 997} ms`;
  return `${out}\x1b7\x1b[999;1H\x1b[48;2;42;29;20m\x1b[38;2;255;176;102m agent-${id} · ${n} updates \x1b[K\x1b[0m\x1b8`;
}
/** Same grid for every renderer at a given count (from the stress ramp). */
function layout(count, width, height) {
  let best;
  for (let across = 1; across <= count; across++) {
    const down = Math.ceil(count / across);
    const tw = width / across,
      th = height / down;
    const font = Math.min(tw / (80 * 0.6), th / (24 * 1.2));
    if (!best || font > best.font)
      best = { across, down, tw: Math.floor(tw), th: Math.floor(th), font };
  }
  return { ...best, cols: 80, rows: 24, font: Math.max(5, Math.floor(best.font * 100) / 100) };
}

// ---------------------------------------------------------------- renderers
function xtermLike(term, rows) {
  return {
    write: (d) => new Promise((done) => term.write(d, done)),
    focus: () => term.focus(),
    async text() {
      const b = term.buffer.active;
      const out = [];
      for (let y = Math.max(0, b.length - rows); y < b.length; y++)
        out.push(b.getLine(y)?.translateToString(true) ?? '');
      return out.join('\n');
    },
    async retained() {
      return term.buffer.active.length;
    },
    grid: () => ({ cols: term.cols, rows: term.rows }),
  };
}

async function mount(type, host, g, scrollback) {
  const fallback = window.fallbackBytes;
  const { cols, rows, font } = g;
  const lines = scrollback;
  // Byte-limited cores (restty, zem): their largest allowed limit.
  const bytes = 256_000_000;
  if (type === 'static') {
    // Reference only (idle): the same page with 50 lines of static DOM text and
    // a CSS-blinking caret, i.e. what Chrome spends to show any text at all.
    const pre = document.createElement('pre');
    pre.style.cssText = `margin:0;font:${font}px/1.2 ${FONT_FAMILY};color:#ddd`;
    pre.textContent =
      Array.from({ length: rows - 1 }, (_, i) => logLine(i).replace(/\x1b\[[0-9;]*m/g, '')).join(
        '\n',
      ) + '\n$ ';
    const caret = document.createElement('span');
    caret.textContent = '█';
    caret.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }],
      { duration: 1200, iterations: Infinity },
    );
    pre.append(caret);
    host.append(pre);
    return {
      write: () => Promise.resolve(),
      focus() {},
      text: async () => pre.textContent,
      retained: async () => null,
      grid: () => ({ cols, rows }),
    };
  }
  if (type === 'none') {
    return {
      write: () => Promise.resolve(),
      focus() {},
      text: async () => null,
      retained: async () => null,
      grid: () => ({ cols, rows }),
    };
  }
  if (type === 'wraith' || type === 'wraith-pool' || type === 'wraith-fleet') {
    const term = await Wraith.mount(host, {
      cols,
      rows,
      fit: false,
      fontSize: font,
      lineHeight: 1.2,
      font: FONT_URL,
      scrollback: lines,
      pool: window.benchPool,
      ...(fallback ? { fallbackFonts: [new Uint8Array(fallback)] } : {}),
    });
    return {
      write: (d) => term.write(d),
      // write() resolves once parsed; flush() also waits for the frame.
      flush: () => term.flush(),
      focus: () => term.focus(),
      text: () => term.readText(),
      async retained() {
        return (await term.readText({ scope: 'all' })).split('\n').length;
      },
      grid: () => ({ cols: term.cols, rows: term.rows }),
      term,
    };
  }
  if (type === 'wraith-xterm') {
    const term = new WraithXterm({
      cols,
      rows,
      fontSize: font,
      lineHeight: 1.2,
      fontFamily: FONT_FAMILY,
      cursorBlink: true,
      scrollback: lines,
      allowProposedApi: true,
    });
    term.open(host);
    await term.webgpuReady;
    window.benchRenderer = term.renderer;
    return xtermLike(term, rows);
  }
  if (type === 'xterm-webgl' || type === 'xterm-dom') {
    const term = new Xterm({
      cols,
      rows,
      fontSize: font,
      lineHeight: 1.2,
      fontFamily: FONT_FAMILY,
      cursorBlink: true,
      scrollback: lines,
      allowProposedApi: true,
    });
    term.open(host);
    if (type === 'xterm-webgl') {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => (window.benchLost = (window.benchLost ?? 0) + 1));
      term.loadAddon(webgl);
    }
    return xtermLike(term, rows);
  }
  if (type === 'ghostty-web') {
    // ghostty-web and @wterm/ghostty pass the limit to libghostty, which counts bytes.
    const term = new GhosttyWeb({
      cols,
      rows,
      fontSize: font,
      fontFamily: FONT_FAMILY,
      cursorBlink: true,
      scrollback: bytes,
    });
    term.open(host);
    return xtermLike(term, rows);
  }
  if (type === 'restty') {
    // restty and zem fill their host; the host is sized for cols × rows.
    const term = new ResttyTerm({
      cols,
      rows,
      terminal: {
        fontSize: font,
        showResizeOverlay: false,
        maxScrollbackBytes: bytes,
        fonts: [
          { data: window.fontBytes, name: 'JetBrains Mono' },
          ...(fallback ? [{ data: fallback, name: 'Fallback' }] : []),
        ],
      },
    });
    term.open(host);
    return {
      write: (d) => new Promise((done) => term.write(d, done)),
      focus: () => term.focus?.(),
      text: async () => null,
      retained: async () => null,
      grid: () => ({ cols: term.cols, rows: term.rows }),
    };
  }
  if (type === 'zem') {
    const term = new ZemTerm({
      root: host,
      fontSources: [
        { type: 'buffer', label: 'JetBrains Mono', data: window.fontBytes },
        ...(fallback ? [{ type: 'buffer', label: 'Fallback', data: fallback }] : []),
      ],
      appOptions: { fontSize: font, showResizeOverlay: false, maxScrollbackBytes: bytes },
    });
    return {
      // zem parses synchronously on sendInput and draws in its own frame.
      write: (d) => (term.sendInput(d, 'pty'), Promise.resolve()),
      sync: true,
      focus: () => host.querySelector('textarea,[tabindex]')?.focus(),
      text: async () => null,
      retained: async () => null,
      grid: () => ({ cols: null, rows: null }),
    };
  }
  if (type === 'wterm' || type === 'wterm-ghostty') {
    const core =
      type === 'wterm-ghostty'
        ? await GhosttyCore.load({ wasmPath: ghosttyWasm, scrollbackLimit: bytes })
        : undefined;
    host.style.setProperty('--term-font-size', `${font}px`);
    host.style.setProperty('--term-line-height', '1.2');
    host.style.setProperty('--term-row-height', `${Math.ceil(font * 1.2)}px`);
    host.style.setProperty('--term-font-family', FONT_FAMILY);
    host.style.padding = '0';
    const term = new WTerm(host, {
      cols,
      rows,
      autoResize: false,
      core,
      cursorBlink: true,
      onData: () => {},
    });
    await term.init();
    return {
      // write() parses synchronously and schedules its own frame.
      write: (d) => (term.write(d), Promise.resolve()),
      sync: true,
      focus: () => term.focus?.(),
      text: async () => host.innerText,
      retained: async () => (term.bridge?.getScrollbackCount?.() ?? NaN) + rows,
      grid: () => ({ cols: term.cols, rows: term.rows }),
    };
  }
  throw new Error(`unknown renderer ${type}`);
}

// ---------------------------------------------------------------- lifecycle
let state;

/** Mount, prepare data and fill scrollback; nothing here is measured. */
export async function setup(type, workload, opts = {}) {
  const t0 = performance.now();
  const w = WORKLOADS[workload];
  seed = 1;
  const face = new FontFace('JetBrains Mono', `url(${FONT_URL})`);
  document.fonts.add(await face.load());
  window.fontBytes = await (await fetch(FONT_URL)).arrayBuffer();
  await ghosttyWebInit(); // every page loads the same Wasm, used or not
  // Renderers that rasterize only the fonts they are given (Wraith, restty, zem)
  // get a CJK fallback font for the Unicode workload; the browser-text renderers
  // use system font fallback. Every page fetches it there, used or not.
  if (opts.fallbackFont)
    window.fallbackBytes = await (await fetch(opts.fallbackFont)).arrayBuffer();
  const count = w.terminals ?? 1;
  const multi = count > 1;
  const g = multi ? layout(count, innerWidth, innerHeight) : { ...SINGLE, across: 1, down: 1 };
  if (!multi) {
    g.tw = Math.ceil(g.cols * g.font * 0.6) + 2;
    g.th = Math.ceil(g.rows * g.font * 1.2) + 2;
  }
  if (type === 'wraith-fleet') window.benchPool = Wraith.pool({ workers: 4, surface: 'shared' });
  else if (type === 'wraith-pool') window.benchPool = Wraith.pool({ workers: 4 });
  window.benchLost = 0;
  const grid = document.createElement('div');
  grid.style.cssText = `position:fixed;left:0;top:0;display:grid;grid-template-columns:repeat(${g.across},${g.tw}px);grid-template-rows:repeat(${g.down},${g.th}px)`;
  document.body.append(grid);
  const hosts = Array.from({ length: count }, () => {
    const h = document.createElement('div');
    h.style.cssText = `overflow:hidden;width:${g.tw}px;height:${g.th}px;position:relative;background:#000`;
    grid.append(h);
    return h;
  });
  const scrollback = w.lines ? w.lines + 1000 : 10_000;
  const terms = await Promise.all(hosts.map((h) => mount(type, h, g, scrollback)));
  // Blinking block cursor for every renderer (DECSCUSR 1) and a prompt.
  await Promise.all(
    terms.map((t) => t.write('\x1b[1 q\x1b[32muser@host\x1b[0m:\x1b[34m~\x1b[0m$ ')),
  );
  terms[0].focus();
  const data = {};
  if (w.lines) {
    // Fill scrollback in 1000-line writes, each accepted before the next.
    for (let i = 0; i < w.lines; i += 1000) {
      let s = '';
      for (let k = i; k < Math.min(w.lines, i + 1000); k++) s += logLine(k) + '\r\n';
      await terms[0].write(s);
      if (terms[0].sync) await macrotask();
    }
    for (let k = 0; k < 10; k++) await raf();
  }
  if (workload === 'throughput') data.corpus = corpus(logLine, w.bytes);
  if (workload === 'unicode') data.corpus = corpus(unicodeLine, w.bytes);
  if (workload === 'dense')
    data.frames = Array.from({ length: 120 }, (_, f) => denseFrame(f, g.cols, g.rows));
  if (workload === 'logs') {
    data.ticks = Array.from({ length: 400 }, (_, t) => {
      let s = '';
      for (let k = 0; k < w.linesPerTick; k++) s += '\r\n' + logLine(t * w.linesPerTick + k);
      return s;
    });
  }
  for (let k = 0; k < 5; k++) await raf();
  state = { type, workload, w, g, terms, data, stats: { delivered: 0, skipped: 0, bytes: 0 } };
  return {
    setupMs: performance.now() - t0,
    dpr: devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    layout: g,
    grid: terms[0].grid(),
    corpus: data.corpus
      ? { bytes: data.corpus.bytes, lines: data.corpus.lines, chunks: data.corpus.chunks.length }
      : undefined,
    renderer: window.benchRenderer,
  };
}

/** Paced loop: every interval, each idle terminal gets its next write. */
function paced(intervalMs, next) {
  const { terms, stats } = state;
  const busy = new Array(terms.length).fill(false);
  let n = 0;
  const timer = setInterval(() => {
    n++;
    terms.forEach((t, i) => {
      if (busy[i]) return void stats.skipped++;
      const d = next(i, n);
      busy[i] = true;
      stats.bytes += d.length;
      t.write(d).then(() => {
        busy[i] = false;
        stats.delivered++;
      });
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Start the measured phase. Fixed-work workloads resolve when done. */
export function begin() {
  const { workload, w, terms, data, stats } = state;
  state.t0 = performance.now();
  if (workload === 'typing') {
    const text = 'git commit -m "measure what the terminal costs" && npm test ';
    state.stop = paced(w.intervalMs, (_, n) => {
      const k = (n - 1) % (text.length + 1);
      return k === text.length ? '\r\n$ ' : text[k];
    });
  } else if (workload === 'logs') {
    state.stop = paced(w.intervalMs, (_, n) => data.ticks[n % data.ticks.length]);
  } else if (w.terminals) {
    state.stop = paced(w.intervalMs, (i, n) => logUpdate(i, n));
  } else if (workload === 'dense') {
    let running = true;
    state.stop = () => (running = false);
    (async () => {
      for (let f = 0; running; f++) {
        const d = data.frames[f % data.frames.length];
        stats.bytes += d.length;
        await terms[0].write(d);
        stats.delivered++;
        await raf();
      }
    })();
  } else if (w.kind === 'work') {
    // Up to four writes in flight; synchronous parsers yield a task per chunk.
    state.done = (async () => {
      const t = terms[0];
      const inflight = [];
      for (const c of data.corpus.chunks) {
        inflight.push(t.write(c));
        stats.bytes += c.length;
        if (inflight.length >= 4) await inflight.shift();
        if (t.sync) await macrotask();
      }
      await Promise.all(inflight);
      await t.flush?.();
      await raf();
      await raf();
      stats.delivered = data.corpus.chunks.length;
      state.elapsed = performance.now() - state.t0;
      return finish();
    })();
  }
  return true;
}

function finish() {
  return {
    elapsedMs: state.elapsed ?? performance.now() - state.t0,
    delivered: state.stats.delivered,
    skipped: state.stats.skipped,
    jsChars: state.stats.bytes,
    lostContexts: window.benchLost ?? 0,
  };
}

/** Fixed work: wait for completion (with the runner's timeout). */
export function done() {
  return state.done;
}

/** End a windowed phase and report what was delivered in it. */
export function end() {
  state.elapsed = performance.now() - state.t0;
  state.stop?.();
  return finish();
}

/** After measurement: write a marker and read back what the renderer exposes. */
export async function check() {
  const t = state.terms[0];
  await t.write(`\x1b[0m\x1b[?25h\r\n${MARKER} ${state.workload}\r\n`);
  for (let k = 0; k < 10; k++) await raf();
  await new Promise((r) => setTimeout(r, 300));
  let text = null,
    retained = null;
  try {
    text = await t.text();
  } catch {}
  try {
    retained = await t.retained();
  } catch {}
  return {
    marker: text == null ? null : text.includes(MARKER),
    tail: text == null ? null : text.trimEnd().split('\n').slice(-3).join('\n').slice(-300),
    retained,
    grid: t.grid(),
  };
}
