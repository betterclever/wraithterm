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

| Dense condition                | Before updates/s | After updates/s |  Ratio |
| ------------------------------ | ---------------: | --------------: | -----: |
| Plain                          |              827 |             876 |  1.06× |
| Twenty search-style highlights |               48 |             861 | 17.92× |
| Link hover underline           |               52 |             879 | 16.97× |

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
parse-only evidence, not browser pipeline throughput. Median paired generation
throughput improves **15%, 21% and 25%**, respectively; native parsing of the
shorter equivalent ANSI stream improves about 2%. These percentages compare
within-pair ratios rather than independently aggregated time medians.
Nine complete native
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

## Full browser matrix and regression follow-up

The [90-run matrix](matrix/runs.json) compares `ea398b1` with `e9be65b` and official
xterm 6.0.0 / WebGL addon 0.19.0. Each condition has three rotated repetitions of
512 input updates. All updates render, GPU completion is fenced every 32 updates
and at the end, and initial/final text hashes and canvas geometry agree across
all five targets. SDK/Wasm fingerprints remain unchanged across the batch; all
90 runs passed without browser errors. The [summary](matrix/summary.json) and
[CSV](matrix/summary.csv) retain every target, including the unchanged native
engine. These are headless hardware-accelerated Chrome observations on this
M5 Max, not display FPS or hardware-independent guarantees.

| DPR 1 workload | Wraith before | Wraith after | Change | Official xterm WebGL | Wraith / xterm |
| -------------- | ------------: | -----------: | -----: | -------------------: | -------------: |
| Dense          |           833 |          891 |  +7.0% |                  251 |          3.56× |
| RGB churn      |           826 |          894 |  +8.2% |                  251 |          3.56× |
| Dashboard      |         1,305 |        1,498 | +14.7% |                  597 |          2.51× |
| Pipes          |           446 |          465 |  +4.1% |                  229 |          2.03× |
| Logs           |         6,139 |        5,733 |  −6.6% |                1,060 |          5.41× |

Values are median completed updates/s. The initial log result is retained rather
than silently discarded: it triggered a longer follow-up below. No log speedup
is claimed. The separate native engine is essentially unchanged on dense, RGB,
dashboard and Pipes (about 615, 433, 1,047 and 248 updates/s respectively); the
compatible parser changes do not speed up libghostty itself.

A later [competitor benchmark control check](../competitors/REPORT.md#retina-control-correction)
found that the emulated-DPR2 xterm WebGL resize observer can shrink its actual
backing canvas while its renderer metadata still reports the expected size.
This earlier matrix checked that metadata, so it does **not** establish equal
DPR2 backing-canvas sizes for the xterm comparison. Its DPR2 cross-terminal
ratios are provisional. This finding does not itself invalidate the Wraith-only
paired DPR2 tests; their independent variation and stability caveats remain.

The DPR 2 matrix was unstable: Wraith before ranged from 401–530 and after from
526–869 updates/s. Its apparent +38.8% median gain is **not a dependable speedup
claim**. A separate [same-terminal diagnostic](regression-paired/runs.json)
rotated original/current parser, print and renderer methods independently,
with 512 warmup updates per mode and forty sets of 256 measured updates per
mode, fencing every 32. This found about +6.4% combined DPR 2 throughput, with
P10/P90 paired ratios 0.949–1.124. That is compatible with the earlier +8.0%
input measurement; Retina stability needs dedicated-machine investigation.

The same diagnostic found essentially equal log throughput: input-only 1.000×,
renderer-only 0.996×, combined 0.997× median paired ratios. Combined P10/P90 was
0.947–1.037. Switching implementations changes JIT behavior, so these diagnostic
absolute rates must not be pooled with the full-build matrix. The exact
[harness](regression-paired/harness.json) is archived as source text; it uses the
local baseline paths and ports above.

The [longer full-build log check](logs-confirmation/runs.json) ran seven rotated
repetitions per target with 2,048 updates each (35 runs, no browser errors or
submission/text mismatches). It did not establish a dependable effect: Wraith
before ranged from 1,186–5,904 and after from 2,285–5,756 updates/s; the unchanged
native engine ranged from 1,281–3,309 across its before/after targets. Its apparent
+72.9% Wraith median gain is also **not a valid speedup claim**. Other applications
were active during this shared-machine follow-up. The cause of the variation is
not isolated. Retain the possible initial −6.6% log regression as an open
performance concern until repeated on a quiet machine; the diagnostic gives no
basis for attributing it specifically to input acceleration or overlay packing.

## Next bottleneck

A separate 4,096-update dense CPU sample attributes about **70% of active
sampled CPU time to parsing, 18% to packing and 10% to other renderer work**.
The dispatcher alone accounts for 35.6% self time and UTF-8 decoding 9.8%.
These are sampled CPU shares, not process/device utilization or GPU execution
shares. No timing benchmark ran concurrently. The [profile summary](profile-summary.json)
records the build, all SDK source hashes (including the generated JS parser),
Wasm hash, browser and adapter; the full CPU trace remains ignored locally.
Reproduce with `WRAITH_PROFILE_ITERATIONS=4096 node scripts/profile-renderer.mjs`.

The next high-value experiments are parser dispatch/UTF-8 batching that preserve
all hooks and fragmented input, followed by fewer native libghostty cell-access
calls at the snapshot boundary. The latter needs its own native profile before
choosing an implementation. More shader arithmetic tuning alone cannot remove
the dominant compatible-parser cost. None of these proposed changes are counted
as shipped gains. A stable dense 1,000-update/s result and cross-device/long-run
validation remain open.
