// A live developer workspace for a 200×60 terminal, drawn the way a TUI would: an
// agent session, a latency chart sent as a PNG via Kitty graphics, a live preview
// streamed as Kitty RGBA, a process table and a test runner. Each frame is built on
// demand; the borders and screen setup come once from `setup()`.
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
const base64 = (bytes) => {
  if (bytes.toBase64) return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const apc = (control, b64) => {
  let out = '';
  for (let i = 0; i < b64.length; i += 4096) {
    const more = i + 4096 < b64.length ? 1 : 0;
    out += `\x1b_G${i ? `m=${more}` : `${control},m=${more}`};${b64.slice(i, i + 4096)}\x1b\\`;
  }
  return out;
};
export const COLS = 200;
export const ROWS = 60;
const P = {
  agent: { r: 2, c: 1, h: 44, w: 110, title: 'agent · ~/projects/app' },
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
  ['tool', '● Read src/server/routes/metrics.ts'],
  ['dim', '  └  Read 212 lines'],
  ['say', 'p95 spikes line up with the cache refresh. Batching the writes so the'],
  ['say', 'refresh no longer blocks the request path:'],
  ['tool', '● Update src/server/cache.ts'],
  ['dim', '  └  Updated with 7 additions and 3 removals'],
  ['hunk', '     @@ -41,9 +41,13 @@ export async function refresh(keys: string[])'],
  ['ctx', '       41    const started = performance.now();'],
  ['del', '       42 -  for (const key of keys) await store.set(key, await load(key));'],
  ['add', '       42 +  const values = await Promise.all(keys.map(load));'],
  ['add', '       43 +  await store.setMany(keys.map((key, i) => [key, values[i]]));'],
  ['ctx', '       44    metrics.observe("cache.refresh", performance.now() - started);'],
  ['tool', '● Bash(npm run test -- cache)'],
  ['ok', '  └  ✓ src/server/cache.test.ts (14 tests) 61ms'],
  ['tool', '● Bash(npm run bench:latency)'],
  ['dim', '  └  warming up… 2,000 requests'],
  ['ok', '     p50 3.1 ms → 2.4 ms   p95 14.8 ms → 6.2 ms'],
  ['say', 'p95 drops by more than half. Checking the preview renders the new chart:'],
  ['tool', '● Search(pattern: "useLatency", path: "src/app")'],
  ['dim', '  └  Found 3 files'],
  ['tool', '● Update src/app/dashboard/LatencyCard.tsx'],
  ['add', '       18 +  const series = useLatency({ window: "60s", quantiles: [0.5, 0.95] });'],
  ['think', '* Watching the dev server reload… (esc to interrupt)'],
  ['ok', '  └  vite hmr update /src/app/dashboard/LatencyCard.tsx'],
];
const TESTS = [
  ['ok', ' ✓ src/server/cache.test.ts (14 tests) 61ms'],
  ['ok', ' ✓ src/server/routes/metrics.test.ts (9 tests) 33ms'],
  ['ok', ' ✓ src/app/dashboard/LatencyCard.test.tsx (6 tests) 112ms'],
  ['warn', ' ↓ src/app/auth/session.test.ts > refresh across tabs [skipped]'],
  ['err', ' ✗ src/server/cache.test.ts > setMany keeps order  →  expected [b, a] to equal [a, b]'],
  ['dim', '   ❯ src/server/cache.test.ts:88:23'],
  ['ok', ' ✓ src/server/cache.test.ts > setMany keeps order (retry 1) 18ms'],
  ['dim', ' Test Files  12 passed (12)   Tests  148 passed (148)   Duration  1.42s'],
];
const PROCS = [
  'node server',
  'vite',
  'postgres',
  'redis',
  'agent',
  'tsc --watch',
  'esbuild',
  'vitest',
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

export async function createScene(previewUrl) {
  const site = await createImageBitmap(await (await fetch(previewUrl)).blob());
  const chart = new OffscreenCanvas(712, 208),
    cc = chart.getContext('2d');
  const prev = new OffscreenCanvas(640, 360),
    pc = prev.getContext('2d', { willReadFrequently: true });
  const options = { chart: true, preview: true };
  let imageBytes = 0;
  return {
    options,
    /** Kitty payload bytes produced since the last call. */
    takeImageBytes() {
      const n = imageBytes;
      imageBytes = 0;
      return n;
    },
    setup() {
      return '\x1b[?25l' + bg(C.panel) + `${E}2J` + Object.values(P).map(box).join('');
    },
    /** One frame of the workspace at time `t` seconds. */
    async frame(t) {
      const f = Math.floor(t * 60);
      let out = '\x1b[?2026h\x1b[?25l';
      out +=
        cup(1, 1) +
        bg(0x2a1d14) +
        fg(C.title) +
        fit(
          ` [app] 0:agent*  1:server  2:vite  3:vitest${' '.repeat(90)}cpu ${(38 + 20 * Math.sin(t)).toFixed(0)}%  mem 11.2G  ${String(Math.floor(9 + t / 60)).padStart(2, '0')}:${String(Math.floor(t) % 60).padStart(2, '0')} `,
          COLS,
        ) +
        R;
      const shown = 42,
        total = 12 + Math.floor(f / 6);
      for (let y = 0; y < shown; y++) {
        const n = total - shown + y;
        const [kind, text] = n < 0 ? ['dim', ''] : AGENT[n % AGENT.length];
        const back = kind === 'add' ? bg(C.add) : kind === 'del' ? bg(C.del) : bg(C.panel);
        out += cup(P.agent.r + 1 + y, 3) + back + fg(colorOf[kind]) + fit(text, 106) + R;
      }
      if (options.chart) {
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
            if (x) cc.lineTo(44 + x, y);
            else cc.moveTo(44 + x, y);
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
        cc.fillText('−60 s', 44, 200);
        cc.fillText('now', 676, 200);
        const png = new Uint8Array(
          await (await chart.convertToBlob({ type: 'image/png' })).arrayBuffer(),
        );
        const b64 = base64(png);
        imageBytes += b64.length;
        out +=
          cup(P.chart.r + 1, P.chart.c + 1) +
          apc(`a=T,f=100,i=2,c=${P.chart.w - 2},r=${P.chart.h - 2},C=1,q=2`, b64);
      }
      if (options.preview) {
        // Ease down the page and back, starting on the hero.
        const span = site.height - site.width * 0.5625;
        const scroll = span * 0.5 * (1 - Math.cos((t / 24) * Math.PI * 2));
        pc.drawImage(site, 0, scroll, site.width, site.width * 0.5625, 0, 0, 640, 360);
        const b64 = base64(new Uint8Array(pc.getImageData(0, 0, 640, 360).data.buffer));
        imageBytes += b64.length;
        out +=
          cup(P.preview.r + 1, P.preview.c + 1) +
          apc(`a=T,f=32,s=640,v=360,i=3,c=${P.preview.w - 2},r=${P.preview.h - 2},C=1,q=2`, b64);
      }
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
      const tl = 13,
        ttotal = 8 + Math.floor(f / 4);
      for (let y = 0; y < tl; y++) {
        const n = ttotal - tl + y;
        const [kind, text] = n < 0 ? ['dim', ''] : TESTS[n % TESTS.length];
        out += cup(P.tests.r + 1 + y, 3) + bg(C.panel) + fg(colorOf[kind]) + fit(text, 196) + R;
      }
      return out + '\x1b[?2026l';
    },
    /** Clear images that are switched off. */
    erase(id) {
      return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
    },
  };
}
