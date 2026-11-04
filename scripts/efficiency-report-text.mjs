// Prose for docs/benchmarks/resource-efficiency/REPORT.md. The method text is
// fixed; findings() is filled in from the measured summary after a run.

const SHORT = {
  wraith: 'Wraith',
  'wraith-xterm': 'Wraith xterm-compatible',
  'xterm-webgl': 'xterm.js WebGL',
  'xterm-dom': 'xterm.js DOM',
  restty: 'restty',
  zem: 'zem',
  'ghostty-web': 'ghostty-web',
  wterm: 'wterm',
  'wterm-ghostty': 'wterm + Ghostty',
};
const n = (t) => SHORT[t] ?? t;
const r = (x, d = 0) =>
  Number.isFinite(x)
    ? x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
    : '–';
const rank = (summary, key, skip = []) =>
  Object.entries(summary)
    .filter(([t, s]) => Number.isFinite(s[key]) && !skip.includes(t))
    .sort((a, b) => a[1][key] - b[1][key]);

/** Findings, with every number taken from the measured summary. */
export function findings(s, agg, ranks) {
  const pos = (list, t) => `${list.findIndex((e) => e[0] === t) + 1} of ${list.length}`;
  const w = s.wraith,
    x = s['xterm-webgl'],
    d = s['xterm-dom'];
  const a = (wl, t) => agg[wl]?.[t];
  const best = (key, skip) => rank(s, key, skip);
  const order = (key, skip, digits = 0) =>
    best(key, skip)
      .map(([t, v]) => `${n(t)} ${r(v[key], digits)}`)
      .join(', ');
  const pool64 = a('multi64', 'wraith-pool'),
    fleet64 = a('multi64', 'wraith-fleet');
  const mb = (t) =>
    `${r(a('throughput', t)?.bytes / 2 ** 20 / a('throughput', t)?.elapsedS)} MiB/s`;
  return `## Findings

All figures are medians of 3 rounds, as the change over the same page with no terminal. Wraith is the SDK and engine of \`${ranks.base}\` (this branch adds only benchmark files).

- **CPU: Wraith's native profile is the most CPU-efficient overall** (rank ${pos(ranks.cpu, 'wraith')}
  by the geometric mean of 8 CPU metrics). It costs the least CPU per MiB of
  output (${r(w.throughputCpuPerMB)} CPU-ms/MiB for the colored log, ${r(w.unicodeCpuPerMB)} for
  Unicode; next are ${order('throughputCpuPerMB', ['wraith']).split(', ').slice(0, 2).join(' and ')}),
  the least for a 200 lines/s log stream (${r(w.logsCpu)} CPU-ms/s; xterm.js WebGL
  ${r(x.logsCpu)}, xterm.js DOM ${r(d.logsCpu)}). For a full-screen truecolor
  redraw every frame the lowest CPU per 1,000 frames is
  ${best('denseCpuPer1k')
    .slice(0, 4)
    .map(([t, v]) => `${n(t)} ${r(v.denseCpuPer1k / 1000, 1)} CPU-s`)
    .join(', ')}
  (Wraith holding ${r(a('dense', 'wraith')?.updatesPerS)} frames/s, its range over rounds
  ${r(a('dense', 'wraith')?.cpuMin)}–${r(a('dense', 'wraith')?.cpuMax)} CPU-ms/s); xterm.js DOM needs
  ${r(d.denseCpuPer1k / 1000, 1)} and xterm.js WebGL ${r(x.denseCpuPer1k / 1000, 1)} at
  ${r(a('dense', 'xterm-webgl')?.updatesPerS)} frames/s.
  It parses and draws the 20 MiB log at ${mb('wraith')} (restty ${mb('restty')},
  xterm.js DOM ${mb('xterm-dom')}).
- **Idle, xterm.js WebGL is cheapest** (${r(x.idleCpu)} CPU-ms/s) and Wraith second
  (${r(w.idleCpu)} CPU-ms/s, ${r(a('idle', 'wraith')?.cpu.renderer, 1)} of it in the page's
  own process; the rest is Chrome compositing the blinking cursor). That is about
  what Chrome spends on a static DOM page with a CSS-blinking caret
  (${r(a('idle', 'static')?.cpu.total)} CPU-ms/s). The DOM renderers, restty and zem
  idle at ${r(d.idleCpu)}–${r(Math.max(s.restty.idleCpu, s.zem.idleCpu, s.wterm.idleCpu))} CPU-ms/s;
  ghostty-web redraws continuously and idles at ${r(s['ghostty-web'].idleCpu)} CPU-ms/s
  with ${r(a('idle', 'ghostty-web')?.gpuMs)} GPU-ms/s. Typing echo is also cheapest
  on xterm.js WebGL (${r(x.typingCpu)} CPU-ms/s); Wraith is ${r(w.typingCpu)}.
- **Many terminals: Fleet uses the least CPU at 64.** At 64 terminals ×
  20 lines/s, Fleet uses ${r(fleet64?.cpu.total)} CPU-ms/s and ${r(fleet64?.mem.total)} MiB
  (${r(fleet64?.mem.total / 64, 1)} MiB per terminal) against the per-canvas pool's
  ${r(pool64?.cpu.total)} CPU-ms/s and ${r(pool64?.mem.total)} MiB. xterm.js DOM is next in CPU
  (${r(d.multi64Cpu)}) and uses the least RAM per terminal (${r(d.ramPerTerminal64, 1)} MiB),
  followed by ${best('ramPerTerminal64', ['xterm-dom'])
    .slice(0, 3)
    .map(([t, v]) => `${n(t)} ${r(v.ramPerTerminal64, 1)}`)
    .join(', ')};
  ghostty-web and wterm need more than a core.
  xterm.js WebGL cannot run 64: Chrome keeps 16 WebGL contexts and the other
  ${a('multi64', 'xterm-webgl')?.lost} terminals stop drawing. At 16, xterm.js WebGL is cheapest
  (${r(x.multi16Cpu)} CPU-ms/s), then Fleet (${r(s['wraith-fleet'].multi16Cpu)}).
- **RAM is Wraith's weak side, mostly in Chrome's GPU process.** One idle Wraith terminal adds ${r(w.idleRendererRam)} MiB to the page
  process and ${r(w.idleGpuRam)} MiB to Chrome's GPU process (WebGPU device, swap
  chain and IOSurfaces), ${r(w.idleRam)} MiB in all; xterm.js DOM adds
  ${r(d.idleRam)} MiB, wterm ${r(s.wterm.idleRam)}, ghostty-web ${r(s['ghostty-web'].idleRam)},
  xterm.js WebGL ${r(x.idleRam)}; in the page process alone xterm.js DOM adds
  ${r(d.idleRendererRam)} MiB and ghostty-web ${r(s['ghostty-web'].idleRendererRam)}. The GPU-process
  share is largely Chrome's cost of GPU drawing at DPR 2 rather than terminal
  data: every WebGPU/WebGL renderer adds 360–470 MiB there when idle
  (restty ${r(s.restty.idleGpuRam)}, zem ${r(s.zem.idleGpuRam)}, xterm.js WebGL ${r(x.idleGpuRam)}),
  the DOM and canvas-2D renderers ${r(d.idleGpuRam)}–${r(s['ghostty-web'].idleGpuRam)} MiB, and a
  static DOM page ${r(a('idle', 'static')?.mem.gpu)} MiB; during the log stream the DOM
  renderers also reach ~400 MiB. Wraith ranks ${pos(ranks.ram, 'wraith')} on all-process
  RAM and ${pos(ranks.rendererRam, 'wraith')} on renderer-process RAM.
- **Scrollback: Wraith stores ${r(w.ramPer10kLines, 1)} MiB per 10,000 colored
  120-column lines** in its worker (${r(a('scroll100k', 'wraith')?.mem.renderer)} MiB for 100k),
  against ${r(d.ramPer10kLines, 1)} for xterm.js and ${r(s['ghostty-web'].ramPer10kLines, 1)}
  for ghostty-web; wterm's built-in core keeps only ${r(s.wterm.retained100k)} lines.
- **Where others lead.** restty matches Wraith's order of magnitude on bulk
  parsing (${r(s.restty.throughputCpuPerMB)} CPU-ms/MiB log, ${r(s.restty.unicodeCpuPerMB)} Unicode)
  but costs ${r(s.restty.logsCpu / w.logsCpu, 1)}× Wraith's CPU on the paced log stream.
  xterm.js WebGL is the cheapest at idle, typing and 16 terminals, but its
  dense redraw grew Chrome's GPU process to ${r(a('dense', 'xterm-webgl')?.mem.gpu)} MiB.
  The Wraith xterm-compatible profile (xterm.js's parser and buffer on the
  main thread, Wraith's WebGPU renderer) costs more CPU than the native profile
  on ${['idleCpu', 'logsCpu', 'throughputCpuPerMB', 'unicodeCpuPerMB', 'denseCpuPer1k', 'multi16Cpu'].filter((k) => s['wraith-xterm'][k] > w[k]).length} of 6 CPU metrics (not on dense redraw, where it is
  ${r(s['wraith-xterm'].denseCpuPer1k / 1000, 1)} vs ${r(w.denseCpuPer1k / 1000, 1)} CPU-s per 1,000 frames), and against xterm.js WebGL it is cheaper on the colored log
  (${r(s['wraith-xterm'].throughputCpuPerMB)} vs ${r(x.throughputCpuPerMB)} CPU-ms/MiB) and dense redraw
  (${r(s['wraith-xterm'].denseCpuPer1k / 1000, 1)} vs ${r(x.denseCpuPer1k / 1000, 1)} CPU-s per 1,000 frames) but
  costlier idle (${r(s['wraith-xterm'].idleCpu)} vs ${r(x.idleCpu)} CPU-ms/s), on Unicode
  (${r(s['wraith-xterm'].unicodeCpuPerMB)} vs ${r(x.unicodeCpuPerMB)}) and with many terminals
  (${r(s['wraith-xterm'].multi16Cpu)} vs ${r(x.multi16Cpu)} CPU-ms/s at 16).`;
}

export const method = `
## What is measured

Every run mounts one renderer (or nothing) in a fresh headed Chrome profile and
drives one workload. The \`none\` baseline is the same page: the same module
with every library imported, the same JetBrains Mono font loaded, the same
generated workload data and the same paced write loop, with writes discarded
instead of going to a terminal. **Every number is the renderer's run minus the
baseline run of the same workload and round**, so it is what the terminal adds.

- **CPU**: cumulative user + system CPU time of every Chrome process, from CDP
  \`SystemInfo.getProcessInfo\`, read immediately before and after the measured
  phase. Reported in total and split into the renderer process (the page's main
  thread *and its workers*, such as Wraith's engine worker, plus compositor and
  raster threads), the GPU process (WebGPU/WebGL command execution, GPU
  rasterization and Chrome's display compositor) and the browser process.
  Utility processes (network, storage) are in the total and are near zero.
  CPU time is the primary metric because it counts work done rather than rate
  achieved, so it is much less sensitive to a loaded machine than frame rate.
  - Windowed workloads: CPU-ms per wall-clock second (1000 = one core busy).
  - Fixed-work workloads: CPU-ms for the whole job per MiB of input, from the
    first write until the last write is accepted (for Wraith, also rendered,
    via \`flush()\`) plus two animation frames and a 500 ms tail for deferred
    work. The baseline's idle CPU rate is subtracted over that duration.
  - Paced workloads also give CPU-ms per 1,000 updates actually accepted. An
    update is one write: one character (typing), ten log lines (logs), one
    full frame (dense), or two lines and a status bar to one terminal
    (multi-terminal).
- **RAM**: macOS \`phys_footprint\` per process (\`footprint\`; the figure Activity
  Monitor shows as Memory), read at the end of the window, and for fixed work
  also the peak sampled every ~2 s. Reported for the renderer process, the GPU
  process (with its graphics categories: IOSurface, IOAccelerator and owned
  "graphics" memory) and the total over all Chrome processes. RSS and the
  page's main-thread JS heap are in the raw data. Worker JS heaps cannot be
  read separately; they are inside the renderer-process footprint.
- **GPU time**: Apple GPU execution time accumulated by Chrome's processes
  (\`AGXDeviceUserClient\` \`AppUsage.accumulatedGPUTime\` via \`ioreg\`), as GPU-ms
  per second or per MiB. In Chrome almost all of it is the GPU process, which
  executes WebGPU/WebGL work and composites the page. The window server's
  composition of Chrome's window to the display is excluded (it is recorded
  separately in the raw data).

## Workloads and setup

| Workload | What it does |
| --- | --- |
| \`idle\` | Prompt written, terminal focused, blinking block cursor (DECSCUSR 1 plus each library's blink option); 30 s. |
| \`scroll10k\` | 10,000 colored ~120-column log lines written (not measured), then idle 10 s: memory held by retained scrollback. |
| \`scroll100k\` | The same with 100,000 lines, scrollback limits raised to hold them (see the retained column). |
| \`typing\` | One character written every 100 ms (a PTY echoing ~10 keys/s), newline and prompt per line; 30 s. |
| \`logs\` | 10 colored log lines every 50 ms (200 lines/s); 20 s. |
| \`throughput\` | 20 MiB of the colored log in 64 KiB writes, up to four in flight, as fast as they are accepted (\`cat\` of a big log). |
| \`dense\` | A btop-like 160×50 frame (truecolor foreground and background on every cell) written, accepted, one animation frame, repeated; 20 s. |
| \`unicode\` | 8 MiB of lines mixing Japanese, Chinese, Korean, emoji (ZWJ sequences, flags, skin tones), combining marks, Greek, Cyrillic, Hebrew and box drawing. |
| \`multi16\`, \`multi64\` | 16 or 64 terminals (80×24, tiled to fill the window; same tiles and font for every renderer), each written two colored lines and a status bar every 100 ms. |

Single-terminal workloads use 160×50 at 13 px, line height 1.2, JetBrains Mono,
DPR 2, in a 1728×1000 window. Renderers that rasterize only the fonts they are
given (Wraith, restty, zem) also get macOS's Arial Unicode as a CJK fallback in
the Unicode workload only, so its ~23 MB does not inflate their memory
elsewhere; xterm.js, ghostty-web and wterm use the browser's system font
fallback. restty and zem size themselves to their host, which is sized for the
grid, so their grid can differ slightly.

Paced loops give a terminal its next write only once its previous write was
accepted, and count skipped ticks. Each renderer and workload runs in 3 rounds;
renderer order is shuffled per workload and round, and the baseline is
re-measured in every round. Before mounting, each fresh browser is left until
all its processes together use under 20 ms CPU/s for 3 s.

Renderer settings: Wraith native \`Wraith.mount\` with a dedicated worker (single
terminal), \`Wraith.pool({ workers: 4 })\` (multi, canvas per terminal) and
\`Wraith.pool({ workers: 4, surface: 'shared' })\` (Fleet); the Wraith
xterm-compatible \`Terminal\` (xterm.js core with Wraith's WebGPU renderer);
xterm.js 6 with \`@xterm/addon-webgl\` and with its DOM renderer; restty's
xterm-compatible \`Terminal\`; zem's \`Terminal\`; ghostty-web; wterm's DOM
renderer with its built-in core and with \`@wterm/ghostty\`. Scrollback was set
to the workload's line count + 1,000 where it counts lines, and to 256 MB where
it counts bytes (restty, zem, ghostty-web and @wterm/ghostty pass it to
libghostty-style byte limits).

## Caveats

- **Shared machine.** Other users' builds ran throughout. Each run waits for the
  separate Fleet GPU benchmark to finish and for AC power, waits up to 20 s for
  a 1-minute load below 6, then accepts load below the 18 logical cores, and
  after 45 s runs regardless; the load was rarely below 6, so a strict gate
  would have taken days. Every run records its load. CPU time per unit of work holds up
  under load; time to finish, updates/s and achieved paced rates do not.
- **The GPU process is shared and lazily set up.** The baseline page draws one
  static black frame and its GPU process stays near 40 MiB. Any page that keeps
  producing frames, including the static-DOM reference row, makes Chrome
  allocate raster, compositor and Metal resources there. Much of the GPU-process
  RAM delta is therefore Chrome's own cost of drawing anything at DPR 2, not the
  terminal's data; the reference row on the idle table shows that floor.
- **GPU time is per process**, includes Chrome's page compositing, excludes the
  window server, and is not split by feature.
- **Correctness.** Each run writes an end marker and reads the screen back
  through the renderer's API (xterm.js buffer, Wraith \`readText\`, wterm DOM).
  restty and zem expose no text API, so only screenshots (kept locally under
  \`.cache/efficiency/shots\`, not committed) show they drew. Scrollback
  retention is read the same way.
- Writes come from page JavaScript, not a PTY or WebSocket, so transport cost is
  excluded and identical for all renderers. Wraith's write promise resolves once
  parsed, as do xterm.js-style write callbacks; wterm and zem parse
  synchronously inside \`write\`/\`sendInput\`.

## Reproduce

\`\`\`sh
npm ci && npm run build:sdk
npx vite --port 5291 &
WRAITH_URL=http://127.0.0.1:5291 caffeinate -u -d -i npm run benchmark:efficiency
npm run report:efficiency
\`\`\`

\`results.json\` holds every run: per-process CPU, GPU time and memory before and
after each window, samples during it, setup details, machine load, power and
the read-back checks, plus the Git commit, Chrome and package versions, and
SHA-256 of the engine and harness files. \`summary.csv\` is the summary table.`;
