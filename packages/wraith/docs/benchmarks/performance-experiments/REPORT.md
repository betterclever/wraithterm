# Performance alternatives: correctness and throughput study

**No additional 2× end-to-end gain was established.** Short paired blocks find
about **7% on dense repaint, 6% on RGB churn, 12% on the dashboard and 8% on
Retina dense repaint** for parameter batching plus bulk ASCII printing. Logs and
Pipes have no convincing gain from that combination. All performance paths are
research prototypes; the shipped SDK and its Wasm engine remain unchanged.

Nine paths passed the final **162-run** matrix: 135 DPR-1 runs across five
workloads and 27 DPR-2 dense runs. Every run submits its 1,024 counted updates
and fences GPU completion. An additional **1,440 short blocks** across six
conditions compare baseline, parameter batching and their combination on the
same terminal/device. These are completed updates, not display presentation FPS.

## Short paired confirmation

[Raw paired blocks](paired/runs.json) and [summary](paired/summary.json).
Eighty rotated baseline/params/combined triplets per condition, 32 updates per
block, with a completion fence after each block. Each action warms for 256
updates before measurement. Ratios compare each prototype with the baseline in
its own triplet; the columns below are medians of those per-triplet ratios.

| Workload                | Params vs baseline | Params + bulk print vs baseline | Combined ratio change, P10–P90 |
| ----------------------- | -----------------: | ------------------------------: | -----------------------------: |
| Dense repaint / DPR 1   |               5.4% |                            7.0% |                     2.7%–12.8% |
| RGB churn / DPR 1       |               5.0% |                            5.9% |                    -2.9%–14.1% |
| Eight-line logs / DPR 1 |               2.5% |                           -1.9% |                   -38.6%–66.2% |
| Dashboard / DPR 1       |               5.8% |                           12.0% |                     6.1%–17.3% |
| 3D Pipes / DPR 1        |               2.0% |                            0.1% |                     -1.5%–5.6% |
| Dense repaint / DPR 2   |               7.3% |                            8.2% |                     4.4%–12.5% |

P10/P90 describe the observed distribution of individual paired ratios. They
are not confidence intervals. Dense and dashboard direction is consistent in
most paired blocks. Logs are dominated by short-block fence/scheduling variation;
their apparent percentages are not established gains. Pipes remains primarily
input-bound and the ASCII print path does not accelerate its block characters.

Absolute rates from the main, paired and older benchmark reports must not be
pooled. Background CPU activity changed substantially during this study,
including active virtual-machine, browser and window-server processes. The
paired runs reduce order bias but do not isolate this machine or remove GPU,
frequency, cache and scheduling uncertainty. No samples from either final batch
were removed. Earlier pilots and interrupted harness checks remain in local
.cache/performance-experiments; they are not pooled into these results.

## Main matrix: all alternatives

[Raw runs](runs.json), [summary](summary.json), and [Retina runs](retina/runs.json).
Medians of three 1,024-update runs per workload/path; rotated starting path and
reversed order on alternate repetitions. Completed updates/s:

| Path           | Dense | RGB churn |  Logs | Dashboard | Pipes |
| -------------- | ----: | --------: | ----: | --------: | ----: |
| baseline       |   809 |       786 | 4,245 |       828 |   384 |
| params         |   830 |       853 | 4,785 |     1,019 |   381 |
| print          |   794 |       823 | 4,717 |     1,150 |   379 |
| combined       |   862 |       849 | 4,717 |     1,300 |   330 |
| wasm-scalar    |   812 |       811 | 5,392 |       959 |   406 |
| wasm-simd      |   802 |       781 | 4,669 |     1,263 |   371 |
| combined-simd  |   862 |       848 | 4,617 |     1,195 |   369 |
| fused          |   792 |       776 | 5,375 |       726 |   251 |
| combined-fused |   839 |       833 | 5,115 |       482 |   250 |

These long-run medians include substantial shared-machine noise. In particular,
the apparent dashboard and log gains are larger than short paired confirmation
supports. Use the paired table to assess the input experiments; use all raw
ranges to assess uncertainty. None of the matrix rows proves a general 2× gain.

The experiment paths:

- **params:** generate xterm's original pinned dispatcher/async continuation
  from its MIT-licensed source, changing only the ordinary numeric-parameter
  accumulation. Colon subparameters, saturation and rejected parameters still
  use the original parameter behavior. The previous fragmented-colon bug is
  corrected. The generator rejects a changed upstream source hash.
- **print:** store a complete ordinary ASCII run directly in its current row.
  Wrapping, insert mode, custom Unicode providers, charset translation,
  accessibility, extended attributes and non-ASCII runs use upstream printing.
  The original wide-cell repair behavior is preserved.
- **combined:** install both instance-local input experiments.
- **wasm-scalar / wasm-simd:** a separate no_std Rust Wasm module converts
  supported ordinary rows to the existing five-word GPU format. SIMD converts
  four truecolor cells at once. Warm glyph lookup still requires scalar gathers.
  Unsupported rows use the unchanged JavaScript packer. Timings include copying
  raw rows into this module and packed words back to engine staging.
- **combined-simd:** input experiments plus the SIMD packing module.
- **fused:** opportunistically stage warm scalar print runs while retaining the
  canonical row-word checks. Changed staging must upload instead of retaining
  its previous GPU owner; source-row reuse must exclude staged dirty rows.
- **combined-fused:** input experiments plus that staging prototype.

Fusion performs duplicate validation/style work on many tiny print runs and
regresses Pipes materially. Scalar/SIMD packing does not establish a broad
pipeline win: copies, row eligibility checks, fallback rows and glyph lookups
matter. The SIMD shortcut is not a complete replacement for xterm's cell model.
The research wrappers must not be treated as shippable SDK integration.

## Independent stage observations

1,024 iterations per stage, separate from pipeline timing. Rates below are
observations under the load at that point, not intrinsic hardware ceilings:

| Workload / DPR 1 | Parse only | Pack only | Prepacked full upload + GPU | Retained fixed-image redraw |
| ---------------- | ---------: | --------: | --------------------------: | --------------------------: |
| Dense repaint    |      1,144 |     5,120 |                       4,448 |                       4,682 |
| RGB churn        |      1,118 |     4,995 |                       4,324 |                       4,686 |
| Eight-line logs  |    107,789 |     8,387 |                       6,448 |                       7,096 |
| Dashboard        |      1,725 |     7,091 |                       5,838 |                       5,818 |
| 3D Pipes         |        430 |     7,019 |                       4,277 |                       4,389 |

Parse-only does no drawing. Pack-only repeatedly forces packing of a warm fixed
viewport without drawing. Prepacked upload alternates eight previously packed
snapshots, uploads all **384,000 cell bytes/update**, and submits a draw. Retained
redraw draws the same image with zero cell uploads. Both GPU loops verify exactly
1,024 submissions and fence every 32 plus the final batch.

The dense DPR-1 prepacked path observes roughly **4,448 completed draws/s** and
Pipes roughly **4,277**. That demonstrates headroom in this renderer under those
conditions, while excluding the parser and packer that consume most live work.
It does not show a terminal delivering 4,000 distinct live frames/s.

DPR-2 dense observations are parse 517, pack
2,312, prepacked upload 920,
and retained redraw 541 per second. The retained loop
was slower than full upload in this single ordered sample, despite uploading
less. That is evidence of interference/order uncertainty; it cannot support a
hard Retina GPU ceiling. Multiple isolated GPU runs would be needed for that.

The remaining 2× target needs substantially less input work on the live path.
These experiments test batching and opportunistic staging, not a fully fused
UTF-8 tokenizer/terminal-state/GPU-record architecture. Skipping ANSI sequences,
parser hooks, Unicode semantics or counted submissions would not satisfy the
compatibility target. The native Ghostty parser was not accelerated by these
xterm-only prototypes.

## Correctness and integration

- Each input path compares **16,554 fragments and 336 full state snapshots**
  against upstream xterm, with 2,500 seeded atoms. Checks include malformed CSI,
  overflow/subparameters, byte-by-byte UTF-8, wrapping/wide-cell repair, margins,
  insert/delete, alternate screen, hyperlinks, accessibility, custom Unicode
  providers, all four asynchronous hook types, reset during continuation and
  writes larger than the decoder chunk limit.
- Packing/fusion paths require byte-identical GPU cell words across all eight
  workload variants. Three actual GPU images per path/condition require
  byte-identical pixels against a forced canonical packing of the same state:
  **162 image comparisons** across the two final matrices. xterm's fading DOM
  scrollbar is hidden for this comparison; canvas geometry/cells are intact.
- **20 complete Chrome API checks** pass on the shipped SDK and on the input
  combination with the prototypes actually installed. The experimental driver
  records installation proof. Original addons, async hooks, memory growth,
  retained rows, fallback and resource disposal are covered.
- **30 SDK/demo tests**, **44 native Rust/libghostty tests**, Wasm integration
  over **31 stream boundaries and 100 create/free cycles**, strict TypeScript,
  Rust formatting, SDK build and production demo build pass.
- The full native Chrome suite passes. **60 incremental frames** have identical
  pixels/text against the preserved build at DPR 1/2 in both profiles, and
  **22 packed-cell/state fixtures** match.
- Installed native and unchanged @xterm/xterm alias consumers pass in Vite
  development and production. Pipes checks cover three renderers, live/replay,
  XP growth/reset, one-to-six rebuild, pause, mobile/DPR2 and reduced motion.

Testing also fixed stale Pipes frame/scene statistics during asynchronous
rebuild, the obsolete native-help assertion, and a DOM fallback check that
read rows before queued welcome text rendered. The Pipes fix affects lab
observability, not terminal engine semantics or the measured input byte streams.

Machine-readable validation records are in [validation](validation/xterm.json).
Cached screenshots and full profiles are not committed. The official engine was
not rebuilt because its Rust/source code did not change; native source tests
and the unchanged prebuilt Wasm were both exercised. The separate packing kernel
was compiled for this experiment only.

## Identity and repeatability

- Runtime base: e968715; main matrix harness commit: dd701cb. Each raw record
  includes its measured Git head, source manifest and generated parser/kernel
  hashes. The paired runner was subsequently committed in 7492f5f; its source
  hash is recorded in the paired data.
- Apple M5 Max, 18 logical CPUs, 48 GiB; Chrome 155 headless, Apple/Metal 3;
  xterm 6.0.0; JetBrains Mono 15 CSS px; grid 240×80. DPR 1 is 2160×1600 pixels;
  DPR 2 is 4320×3200.
- Wasm SHA-256 remains
  40f031244d3a09bf16c51ea7064f31ad2e33f3962889ebc6b4899dfe1ef4f552.
- Rust research kernel: rustc 1.98.1, opt-level=3, panic=abort, simd128 enabled.
  Generated input source, kernel binary and all runtime files are fingerprinted.
  Every input variant is hashed and checked across the main prototype paths.
- No utilization sampler or CPU profiler ran concurrently with throughput
  measurement. Sampled CPU work shares from earlier profiling are not CPU/GPU
  utilization percentages. This study does not report per-library GPU usage.

With the SDK built and npm run dev on localhost:5173:

```sh
WRAITH_REPORT_DIR=.cache/experiments npm run benchmark:experiments
WRAITH_REPORT_DIR=.cache/experiments-retina WRAITH_WORKLOADS=complex \
  WRAITH_DPRS=2 npm run benchmark:experiments
WRAITH_REPORT_DIR=.cache/experiments-paired node scripts/paired-input-experiment.mjs
npm run test:experiments
```

The experiment runner builds its standalone Wasm module automatically and
requires the installed wasm32-unknown-unknown Rust target. Browser experiments
use request-local routes; they do not edit the running SDK or native worker.
