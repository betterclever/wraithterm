# Production performance pass — 17 October 2026

The production xterm-compatible input path now batches numeric parameters and
prints ordinary fixed-width runs directly into the pinned xterm cell layout.
The original dispatcher, hooks and async continuation remain intact. UTF-8,
nontrivial Unicode, wrapping, accessibility, charsets, custom Unicode providers,
insert mode and extended attributes retain upstream behavior.

The generated dispatcher is derived at build time from hash-checked xterm 6.0.0
MIT source, without runtime evaluation. Its upstream license remains packaged.
Single ASCII and box/block drawing characters join the fast path, which matters
for truecolor half-block graphics. This changes the compatible profile, not the
native libghostty parser or Wasm engine.

## Same-device paired measurements

Apple M5 Max, headless Chrome 155, hardware Apple/Metal 3, 240×80 cells. Forty
rotated baseline/params/combined triplets per condition; 32 updates per block,
256 warmup updates per action. Each block counts every submission and waits for
GPU completion. These are completed updates, not physical display FPS. Sources,
Wasm hash and raw samples are recorded in [input/runs.json](input/runs.json).

| Workload          | Baseline updates/s | Combined updates/s | Median paired gain |
| ----------------- | -----------------: | -----------------: | -----------------: |
| Dense / DPR 1     |                842 |                891 |               5.9% |
| RGB churn / DPR 1 |                833 |                877 |               5.3% |
| Logs / DPR 1      |              6,531 |              6,809 |       inconclusive |
| Dashboard / DPR 1 |              1,306 |              1,488 |              13.9% |
| Pipes / DPR 1     |                435 |                455 |               4.2% |
| Dense / DPR 2     |                714 |                777 |               8.0% |

Rates are medians of individual blocks. Gains are medians of within-triplet
ratios, so they need not equal the ratio of rate medians. Logs have wide paired
variation spanning regressions and gains; no log improvement is established.
The full distributions are in [input/summary.json](input/summary.json). This is
a shared machine and short-block throughput, not long-term stability evidence.
The dense 1,000-update/s target remains open.

The earlier [ASCII-only candidate](ascii/summary.json) improved dense/dashboard
but not Pipes. Its full raw batch is retained; the wider fixed-width path was
measured in a separate batch and must be compared with its own paired baseline.

## Validation

- 31 SDK/demo tests, strict TypeScript, SDK and production demo builds pass.
- Production imports pass the existing upstream differential corpus: 16,554
  fragments, 336 state snapshots, all four async hook kinds, fragmented UTF-8,
  malformed/overflow CSI, custom width providers and reset during continuation.
- All 160 box/block codepoints additionally exercise combining suffixes,
  wide-cell repair and right-margin wrapping against upstream.
- All 20 Chrome xterm API checks pass, including hooks, addons, resource disposal,
  memory growth, retained rows and renderer fallback.
- 22 packed-word differentials match the preserved baseline at DPR 1/2.
- Packed npm alias consumers pass Vite development and production, preserving
  original `@xterm/xterm` imports and addons.

Before build: `ea398b1`. Wasm remains
`40f031244d3a09bf16c51ea7064f31ad2e33f3962889ebc6b4899dfe1ef4f552`.
No CPU/GPU utilization measurement ran alongside throughput.

Run `npm run build:sdk`, `npm run test:input` and, with the demo server running,
`node scripts/paired-production-input.mjs` to reproduce the production actions.

## GPU decoration coverage

Search-style cell colors and link hover underlines now stay on WebGPU. Previously
either feature switched the entire viewport to the retained DOM renderer.
Decorations retain upstream callbacks, DOM elements and overview rulers. Top
decorations override selection; selection overrides bottom decorations. Rows
with overlays cannot reuse stale packed cells. Clearing overlays restores normal
row caching. Transparency, contrast adjustment and character joiners still fall
back to DOM.

Three alternating before/after runs, dense 240×80 DPR1, 64 warmup and 256 measured
updates each, in [overlays/runs.json](overlays/runs.json). Before is `ea398b1`;
after includes the input changes above. DOM timings include forced layout;
WebGPU runs fence every 32 and verify all 256 submissions. DOM updates are not
GPU-completed frames, and these are not display presentation rates.

| Dense condition | Before updates/s | After updates/s | Ratio |
| --- | ---: | ---: | ---: |
| Plain | 827 | 876 | 1.06× |
| Twenty search-style highlights | 48 | 861 | 17.92× |
| Link hover underline | 52 | 879 | 16.97× |

The decorated/hover benefit primarily comes from avoiding DOM fallback; it must
not be described as a universal parser or renderer multiplier. Initial/final
text is equal. Actual background pixel samples match upstream DOM for all 40
cells in an overlapping decoration/selection row at DPR 1 and 2. Wrapped hover
ranges, cleanup and callbacks pass. The full 20-check API suite and packed
development/production alias consumers pass with GPU decorations enabled.

Reproduce with `node scripts/overlay-browser-test.mjs` and
`WRAITH_BASELINE_DIR=.cache/gold-baseline node scripts/overlay-benchmark.mjs`,
serving the preserved baseline on port 5190 and the current build on port 5173.

## Ghost Reactor producer and live scheduling

The demo now writes UTF-8/ANSI directly into reusable scratch memory. Simultaneous
foreground/background changes share an SGR sequence; no colors are quantized and
no terminal content is omitted. Each returned frame owns its transfer buffer.
Live writes use the native terminal's existing render scheduler instead of
forcing a GPU fence per update. Paused seeks/capture still call `flush()` and the
public SDK's completion guarantee is unchanged. The counter now explicitly says
parsed updates/s, not GPU-completed updates/s.

Node CPU observations in [ghost/runs.json](ghost/runs.json) compare 40 alternating
pairs after eight warmups at 120×34, 192×54 and 240×68. This is scene-generation and
parse-only evidence, not browser pipeline throughput. Nine complete native
snapshots compare every cell and text: **92,304 cell comparisons** agree exactly.
The live browser checks cover startup, grids, pause/resume, replay, pointer/pulse,
ANSI download, and deterministic GPU captures. Native browser integration and
packed native consumers pass. Sixty incremental DPR1/2 frames across both profiles
remain byte-identical to the preserved build, alongside 22 packed-word fixtures.

## Additional experiment rejected

Inlining ordinary parameter insertion into the generated parser passed the same
16,554-fragment differential corpus. Forty alternating pairs per condition found
only about 0.6% dense, 1.1% RGB, 0.9% dashboard and 1.3% Pipes improvement, with
most distributions spanning no gain. That small benefit does not justify an
additional dependency on parameter-container internals. It is **not installed**.
All samples, the generated candidate and the exact pilot harness are preserved
under [inline-params](inline-params/runs.json). To rerun that harness, write the `source` field from `inline-params/harness.json`
to `.cache/parameter-inline-pilot.mjs` from the repository root.

The earlier SIMD packing and fused-staging experiments remain rejected on their
existing evidence; this pass does not relabel them as optimizations.
