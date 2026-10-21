# Terminal workflow benchmarks

Build the SDK and production demo, then serve it with Vite preview. Run one
hardware benchmark at a time; builds and other GPU tests must finish first.

```sh
npm run build:sdk
npm run build:demo
npx vite preview --host 127.0.0.1 --port 5196 --strictPort
```

In another terminal:

```sh
WRAITH_URL=http://127.0.0.1:5196 \
WRAITH_REPETITIONS=3 WRAITH_SUSTAINED_MS=60000 \
npm run benchmark:workflows
```

The matrix covers compiler logs, editor-style redraws, sparse dashboards, large
writes, Unicode, byte-wise streams, progress bars, alternate screens, erasing,
hyperlinks, dense color updates, scrolling, the Ghost showcase and 3D Pipes.
It compares xterm DOM, xterm WebGL, Wraith's compatible renderer, and Wraith's
native core. The browser uses a matching device scale factor at startup and in
its emulated viewport; WebGL's actual viewport must match its drawing buffer.

The throughput path uses the synchronous semantic cores, precomputed input,
32-update warmup, rotated run order and completion fences every 32 submissions.
It records parser/render CPU percentiles and completed logical updates per
second. DOM forces layout and has no GPU fence. A counter of 1000 updates/s does
not establish 1000 physical display presentations/s.

Public SDK interactions measure real key events at idle and under a roughly
4 MiB/s offered output flood, search through 9000 lines, selection of that
history, resize, and 64 KiB/1 MiB bracketed paste plus echo. Key-to-input,
parse acknowledgement, render notification and the following rAF opportunity
are separate measurements. An `onRender` event observes command submission;
it does not prove GPU completion or display scanout. Native worker render
notifications are opt-in and are disabled after the final listener is removed.
Paste parse acknowledgement and forced completion are also reported separately.

The sustained phase drives eight 80x24 terminals toward 30 batches/s, with
64 log lines per terminal per batch and equal configured retention. It records
achieved rate, isolated Chrome CPU time, main-page JS heap and process RSS before
load, during load and after disposal. JS heap excludes native worker heaps and
most Wasm/GPU allocations. Summed RSS can double-count shared mappings. macOS
GPU-driver utilization is device-wide, includes other applications and has an
undocumented averaging window. These bounded runs do not certify leak absence.

Fixed-count replay hashes compare visible contents with upstream DOM. Pipes
checks both halves of every terminal cell against actual screenshot pixels.
Rows with mismatched contents, geometry or checked pixels must be excluded from
valid speed comparisons. A matching text buffer does not certify all glyphs;
native CJK/emoji font coverage remains explicitly unverified in this benchmark.
The editor scene is a synthetic redraw workload, not a recorded Neovim session.

`runs.json` retains every repetition, errors, hardware/browser/package versions,
source hashes, CPU counters and sample distributions. Screenshots remain local.
Keep its report and source commit together when sharing conclusions.

Configuration uses `WRAITH_DPRS`, `WRAITH_TYPES`, `WRAITH_CASES`,
`WRAITH_PHASES`, `WRAITH_COLS`, `WRAITH_ROWS`, `WRAITH_FRAMES`,
`WRAITH_MIN_MS`, `WRAITH_KEYS`, `WRAITH_REPETITIONS`,
`WRAITH_SUSTAINED_MS` and `WRAITH_REPORT_DIR`. An immutable archived build can
set `WRAITH_SOURCE_ROOT` and `WRAITH_BUILD_HASH` while serving that archive's
production output. Do not change measured sources or rebuild the served output
while a run is active.
