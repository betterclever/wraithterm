// Prose for docs/benchmarks/resource-efficiency/REPORT.md. The method text is
// fixed; findings() is filled in from the measured summary after a run.

export function findings() {
  return '## Findings\n\n(pending: run the benchmark)';
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
  - Paced workloads also give CPU-ms per 1,000 updates actually accepted.
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
