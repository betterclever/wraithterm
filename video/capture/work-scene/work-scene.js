// A realistic developer workspace in one 200x60 terminal, laid out like tmux:
// an AI coding-agent session (left), a live latency chart sent as a PNG via Kitty
// graphics and a live browser preview of the site being built, streamed as Kitty
// RGBA (right), an htop-style table, and a test runner (bottom). Frames are built
// in the page before timing; frame 0 carries the borders and one-time setup.
const COLS = 200;
const E = '\x1b[';
const cup = (r, c) => `${E}${r};${c}H`;
const fg = (h) => `${E}38;2;${(h >> 16) & 255};${(h >> 8) & 255};${h & 255}m`;
const bg = (h) => `${E}48;2;${(h >> 16) & 255};${(h >> 8) & 255};${h & 255}m`;
const R = `${E}0m`;
const fit = (s, w) => (s.length > w ? s.slice(0, w) : s.padEnd(w, ' '));
const C = {
  frame: 0x6a4f3a,
  title: 0xffb066,
  dim: 0x7d6e62,
  text: 0xe8e0d6,
  ok: 0x8ee0a0,
  warn: 0xffcc66,
  err: 0xff7a6e,
  add: 0x123d22,
  del: 0x4a1a1a,
  blue: 0x8fb8ff,
  panel: 0x0d0a08,
};
const apc = (control, b64) => {
  let out = '';
  for (let i = 0; i < b64.length; i += 4096) {
    const more = i + 4096 < b64.length ? 1 : 0;
    out += `\x1b_G${i ? `m=${more}` : `${control},m=${more}`};${b64.slice(i, i + 4096)}\x1b\\`;
  }
  return out;
};
// Pane geometry (1-based rows/cols, inclusive borders).
const P = {
  agent: { r: 2, c: 1, h: 44, w: 110, title: 'claude · ~/projects/wraith' },
  chart: { r: 2, c: 112, h: 15, w: 89, title: 'latency · p50 / p95 (ms)' },
  preview: { r: 17, c: 112, h: 18, w: 89, title: 'preview · localhost:5173' },
  top: { r: 35, c: 112, h: 11, w: 89, title: 'top' },
  tests: { r: 46, c: 1, h: 15, w: 200, title: 'vitest --watch' },
};
function box({ r, c, h, w, title }) {
  let out =
    fg(C.frame) +
    cup(r, c) +
    '╭─ ' +
    fg(C.title) +
    title +
    fg(C.frame) +
    ' ' +
    '─'.repeat(w - title.length - 5) +
    '╮';
  for (let y = 1; y < h - 1; y++) out += cup(r + y, c) + '│' + cup(r + y, c + w - 1) + '│';
  return out + cup(r + h - 1, c) + '╰' + '─'.repeat(w - 2) + '╯' + R;
}
const AGENT = [
  ['tool', '● Read crates/wraith-engine/src/images.rs'],
  ['dim', '  └  Read 334 lines'],
  ['say', "Placements only change when Ghostty's storage generation moves, so the quad"],
  ['say', 'buffer can be rebuilt lazily. Wiring the image layer into the render pass:'],
  ['tool', '● Update crates/wraith-engine/src/gpu.rs'],
  ['dim', '  └  Updated with 9 additions and 2 removals'],
  ['hunk', '     @@ -584,6 +584,13 @@ fn present(&mut self, mut uniforms: Uniforms)'],
  ['ctx', '      584            ..Default::default()'],
  ['ctx', '      585        });'],
  ['del', '      586 -      pass.set_pipeline(&self.pipeline);'],
  ['add', '      586 +      // Kitty z-order: below backgrounds, backgrounds, below text,'],
  ['add', '      587 +      // glyphs and decorations, above text.'],
  ['add', '      588 +      self.images.draw(&mut pass, 1);'],
  ['add', '      589 +      pass.set_pipeline(&self.pipeline);'],
  ['ctx', '      590        pass.set_bind_group(0, &self.bind, &[]);'],
  ['ctx', '      591        pass.draw(0..6, 0..self.cell_count as u32);'],
  ['add', '      592 +      self.images.draw(&mut pass, 2);'],
  ['tool', '● Bash(node scripts/build-engine.mjs)'],
  ['dim', '  └  Compiling wraith-engine v0.2.0'],
  ['dim', '     Finished `release` profile [optimized] target(s) in 41.20s'],
  ['ok', '     Wraith Wasm engine ready.'],
  ['tool', '● Bash(npm run test:native-kitty)'],
  ['ok', '  └  Kitty graphics passed on WebGPU (8×19 px cells): RGBA, scaled PNG,'],
  ['ok', '     chunked zlib RGB, below-background layering, deletion and replies.'],
  ['say', 'Pixels land exactly: RGBA ends at two cells, the PNG scales to 2×2 cells.'],
  ['tool', '● Search(pattern: "set_image_limit", path: "packages/wraith/src")'],
  ['dim', '  └  Found 2 files'],
  ['tool', '● Update packages/wraith/src/types.ts'],
  ['add', '       21 +  /** Decoded Kitty graphics bytes each screen may store. */'],
  ['add', '       22 +  imageStorageLimit?: number;'],
  ['think', '* Benchmarking 1280×720 frame streaming… (esc to interrupt)'],
  ['ok', '  └  rgba-1280x720: 236.4 GPU-completed frames/s, p50 4.20 ms'],
];
const TESTS = [
  ['ok', ' ✓ packages/wraith/src/headless.test.ts (12 tests) 34ms'],
  ['ok', ' ✓ packages/wraith/src/xterm-input.test.ts (9 tests) 21ms'],
  ['ok', ' ✓ demo/pipes-scene.test.js (6 tests) 112ms'],
  ['warn', ' ↓ packages/wraith/src/search.test.ts > reflow across wrapped rows [skipped]'],
  ['ok', ' ✓ crates kitty::chunked_zlib_rgb_and_png_payloads_decode'],
  ['ok', ' ✓ crates kitty::scaling_cropping_offsets_and_layers_follow_the_protocol'],
  ['err', ' ✗ packages/wraith/src/worker.test.ts > resize during fence  →  expected 80 to be 120'],
  ['dim', '   ❯ packages/wraith/src/worker.test.ts:88:23'],
  ['ok', ' ✓ packages/wraith/src/worker.test.ts > resize during fence (retry 1) 18ms'],
  ['dim', ' Test Files  8 passed (8)   Tests  66 passed (66)   Duration  1.42s'],
];
const PROCS = [
  'wraith-worker',
  'ghostty-vt',
  'wgpu-render',
  'claude',
  'cargo build',
  'vite',
  'rust-analyzer',
  'node',
  'esbuild',
  'tsc --watch',
];
const colorOf = {
  tool: C.blue,
  dim: C.dim,
  say: C.text,
  hunk: C.dim,
  ctx: C.dim,
  del: C.text,
  add: C.text,
  ok: C.ok,
  warn: C.warn,
  err: C.err,
  think: C.title,
};

export async function build(count) {
  const site = await createImageBitmap(await (await fetch('/@fs' + window.SITE_PNG)).blob());
  const chart = new OffscreenCanvas(712, 208),
    cc = chart.getContext('2d');
  const prev = new OffscreenCanvas(640, 360),
    pc = prev.getContext('2d', { willReadFrequently: true });
  const enc = new TextEncoder();
  const frames = [];
  let setup = '\x1b[?25l\x1b[2J' + bg(C.panel) + `${E}2J` + Object.values(P).map(box).join('');
  for (let f = 0; f < count; f++) {
    const t = f / 120;
    let out = (f ? '' : setup) + '\x1b[?2026h\x1b[?25l';
    // tmux-style status bar.
    out +=
      cup(1, 1) +
      bg(0x2a1d14) +
      fg(C.title) +
      fit(
        ` [wraith] 0:claude*  1:vite  2:vitest  3:doomterm${' '.repeat(80)}cpu ${(38 + 20 * Math.sin(t)).toFixed(0)}%  mem 11.2G  ${String(Math.floor(9 + t / 60)).padStart(2, '0')}:${String(Math.floor(t) % 60).padStart(2, '0')} `,
        COLS,
      ) +
      R;
    // Agent session: the latest 42 lines of a streaming transcript.
    const shown = 42,
      total = 12 + Math.floor(f / 3);
    for (let y = 0; y < shown; y++) {
      const n = total - shown + y;
      const [kind, text] = n < 0 ? ['dim', ''] : AGENT[n % AGENT.length];
      const back = kind === 'add' ? bg(C.add) : kind === 'del' ? bg(C.del) : bg(C.panel);
      out += cup(P.agent.r + 1 + y, 3) + back + fg(colorOf[kind]) + fit(text, 106) + R;
    }
    // Live latency chart drawn with canvas text and axes, sent as PNG.
    cc.fillStyle = '#0d0a08';
    cc.fillRect(0, 0, 712, 208);
    cc.strokeStyle = '#2a1f17';
    cc.lineWidth = 1;
    cc.font = '13px monospace';
    cc.fillStyle = '#7d6e62';
    for (let i = 0; i <= 4; i++) {
      const y = 16 + i * 40;
      cc.beginPath();
      cc.moveTo(44, y);
      cc.lineTo(704, y);
      cc.stroke();
      cc.fillText(String(16 - i * 4), 12, y + 4);
    }
    const series = (k, scale, color) => {
      cc.strokeStyle = color;
      cc.lineWidth = 2.5;
      cc.beginPath();
      for (let x = 0; x <= 660; x += 4) {
        const v =
          scale *
          (0.55 +
            0.25 * Math.sin((x + t * 240) / 47 + k) +
            0.12 * Math.sin((x + t * 240) / 13 + 2 * k));
        const y = 176 - v * 160;
        x ? cc.lineTo(44 + x, y) : cc.moveTo(44 + x, y);
      }
      cc.stroke();
    };
    series(0, 0.45, '#8ee0a0');
    series(1.3, 0.85, '#ffb066');
    cc.fillStyle = '#8ee0a0';
    cc.fillText('p50', 640, 30);
    cc.fillStyle = '#ffb066';
    cc.fillText('p95', 640, 48);
    cc.fillStyle = '#7d6e62';
    cc.fillText(`−60 s`, 44, 200);
    cc.fillText('now', 676, 200);
    const pngBytes = new Uint8Array(
      await (await chart.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    out +=
      cup(P.chart.r + 1, P.chart.c + 1) +
      apc(`a=T,f=100,i=2,c=${P.chart.w - 2},r=${P.chart.h - 2},C=1,q=2`, pngBytes.toBase64());
    // Live browser preview: the site scrolling, streamed as RGBA.
    const scroll = ((t * 600) % (site.height - 720)) | 0;
    pc.drawImage(site, 0, scroll, 1280, 720, 0, 0, 640, 360);
    const rgba = new Uint8Array(pc.getImageData(0, 0, 640, 360).data.buffer);
    out +=
      cup(P.preview.r + 1, P.preview.c + 1) +
      apc(
        `a=T,f=32,s=640,v=360,i=3,c=${P.preview.w - 2},r=${P.preview.h - 2},C=1,q=2`,
        rgba.toBase64(),
      );
    // htop-style table.
    out +=
      cup(P.top.r + 1, P.top.c + 2) +
      bg(C.panel) +
      fg(C.dim) +
      fit('  PID USER     CPU%  MEM%  COMMAND', 85) +
      R;
    for (let y = 0; y < 8; y++) {
      const cpu = 50 + 49 * Math.sin(y * 1.9 + t * 1.7),
        bar = Math.round((cpu / 100) * 24);
      let line =
        cup(P.top.r + 2 + y, P.top.c + 2) +
        bg(C.panel) +
        fg(C.text) +
        `${String(1200 + y * 37).padStart(5)} you   ${cpu.toFixed(1).padStart(6)} ${(2 + y * 1.3).toFixed(1).padStart(5)}  ${PROCS[(y + Math.floor(t)) % PROCS.length].padEnd(16)} `;
      for (let i = 0; i < 24; i++)
        line +=
          (i < bar ? bg(i < 12 ? 0x2f8f4e : i < 19 ? 0xc9a13a : 0xd2553f) : bg(0x1a1410)) + ' ';
      out += line + R;
    }
    // Test runner: latest 13 lines.
    const tl = 13,
      ttotal = 8 + Math.floor(f / 2);
    for (let y = 0; y < tl; y++) {
      const n = ttotal - tl + y;
      const [kind, text] = n < 0 ? ['dim', ''] : TESTS[n % TESTS.length];
      out += cup(P.tests.r + 1 + y, 3) + bg(C.panel) + fg(colorOf[kind]) + fit(text, 196) + R;
    }
    out += '\x1b[?2026l';
    frames.push(enc.encode(out));
  }
  return frames;
}
