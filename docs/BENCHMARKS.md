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

The sustained phase drives eight 80x24 terminals toward 12 batches/s, with
64 log lines per terminal per batch and equal configured retention. It records
achieved rate, isolated Chrome CPU time, main-page JS heap and process RSS before
load, during load and after disposal. JS heap excludes native worker heaps and
most Wasm/GPU allocations. Summed RSS can double-count shared mappings. macOS
GPU-driver utilization is device-wide, includes other applications and has an
undocumented averaging window. These bounded runs do not certify leak absence.
Set `WRAITH_STEPS_PER_SECOND` to change the offered batch rate. Only compare CPU
efficiency when the achieved byte rates match; a renderer doing more work can
legitimately consume more CPU.

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
`WRAITH_SUSTAINED_MS`, `WRAITH_STEPS_PER_SECOND` and `WRAITH_REPORT_DIR`. An immutable archived build can
set `WRAITH_SOURCE_ROOT` and `WRAITH_BUILD_HASH` while serving that archive's
production output. Do not change measured sources or rebuild the served output
while a run is active.

Generate the reviewed tables and per-study CSV files with:

```sh
node scripts/summarize-workflows.mjs docs/benchmarks/workflows/baseline/runs.json docs/benchmarks/workflows/stress/runs.json
```

## Native search

The focused [search report](benchmarks/native-search/REPORT.md) compares native,
compatible, upstream DOM and upstream WebGL APIs over 9,000 short lines,
9,000 wrapped Unicode lines and 90,000 short lines. It records exact match counts,
selected text, the first query after writing, subsequent new needles, misses and
warm navigation. Xterm reports all-result counts only with decorations; those
calls perform extra decoration work. Its separate next-only phase does less work
than native’s always-counted API. Timings stop at API completion, not presentation.

```sh
WRAITH_URL=http://127.0.0.1:5196 WRAITH_REPETITIONS=5 npm run benchmark:search
WRAITH_URL=http://127.0.0.1:5196 WRAITH_REPETITIONS=5 WRAITH_SEARCH_MODES=count-only \
WRAITH_REPORT_DIR=docs/benchmarks/native-search/count-only npm run benchmark:search
node scripts/summarize-search.mjs
WRAITH_URL=http://127.0.0.1:5196 npm run test:native-search
```

Run the correctness test before timing and keep builds/other tests idle while
benchmarking. Native’s cache clears before every write or resize, retains at most
32 MiB of page payload plus metadata/working buffers, and remains allocated after
clearing the search UI until content changes or disposal. Histories larger than
the cap remain correct but can evict cached pages. Only the historical faulty
baseline uses `WRAITH_ALLOW_MISMATCH=1`; every final count is strictly validated.

The optional `count-only` mode uses pinned xterm private engine methods to enumerate
matches without markers, decorations, selection or a retained result array.
Native still returns its public count and selected match across the worker.
Treat this as a separate diagnostic; those internals are not a supported API.
`WRAITH_SEARCH_MODES` records the selected phases, and `allowMismatch` is preserved
in configuration for future baseline runs.

## Wrapped bulk text

The [wrapped bulk-text report](benchmarks/bulk-text/REPORT.md) retains 400 alternating production records, stock DOM controls, Unicode 11 fallback controls and complete buffer hashes. Default-provider wrapped parser throughput improves about 1.6–1.9× on the recorded M5 Max run; short colored logs, no-wrap and alternate providers remain controls. Public parse callbacks and parser-only throughput are separate from GPU FPS. The host was busy; use the paired ratios and retained ranges.

```sh
WRAITH_URL=http://127.0.0.1:5196 npm run benchmark:bulk-text
node scripts/summarize-bulk-text.mjs
npm run profile:bulk-text
```

For a paired comparison, provide WRAITH_BEFORE_URL, WRAITH_BEFORE_SOURCE_ROOT and WRAITH_BEFORE_HASH for an immutable baseline. Run profiles separately from timing. See the report for complete fixture and validation details.

## Native hidden panels

The [native visibility report](benchmarks/native-visibility/REPORT.md) compares eight terminals at a fixed acknowledged log rate. Hidden, offscreen and fully clipped panels stop ordinary GPU submissions, with roughly 54–72% lower Chrome CPU time in five paired repetitions. Parsing, history and explicit flush continue. This is inactive-panel efficiency, not a visible-FPS gain. Short and longer visible CPU controls are retained: paired medians increase about 7%, with overlapping ranges on a busy host; do not claim a visible CPU improvement.

```sh
WRAITH_URL=http://127.0.0.1:5196 npm run test:native-visibility
WRAITH_URL=http://127.0.0.1:5196 npm run benchmark:visibility
node scripts/summarize-visibility.mjs
```

For before/after runs provide WRAITH_BEFORE_URL, WRAITH_BEFORE_SOURCE_ROOT and WRAITH_BEFORE_HASH. WRAITH_SETTLE_MS and WRAITH_STEPS configure a longer control; the recorded follow-up uses 5000 ms, 180 batches and visible-only mode. The summarizer expects both the retained matrix and that control. The report includes reproduction commands, source fingerprints, equal-state checks and observer limits.

## GPU effects

The [GPU effects report](benchmarks/gpu-effects/REPORT.md) measures what each
opt-in post-process effect costs a 160x50 terminal at DPR 2 in headless Chrome.
It counts GPU-completed updates per second through `benchmark()`, not display
frames. A GPU-bound update took 0.077 ms with effects off. CRT added 0.028 ms,
bloom 0.059 ms, and all built-ins plus a custom shader 0.095 ms. Static
effects request zero idle frames. With effects off, pixels hash the same as on
`origin/main`.

```sh
WRAITH_URL=http://127.0.0.1:5173 npm run test:native-effects
WRAITH_URL=http://127.0.0.1:5173 npm run benchmark:effects
```
