# Native libghostty performance pass — 17 October 2026

The native profile now batches each SGR command’s style registration and reads ordinary cells from Ghostty’s public bulk row view. On this machine, the final candidate delivers **1.47× dense GPU-completed throughput**, **1.26× churn**, **1.23× dashboards**, and **1.14× Pipes** by the median of paired ratios. Scrolling logs are effectively unchanged. Dense parse-only throughput improves **1.84×**. These results apply to the libghostty profile; they do not replace the separate xterm-compatible or competitor benchmarks.

## Controlled before/after results

Apple M5 Max, 18 logical CPUs, Chrome 155, 240 × 80 cells, 2,000 lines of scrollback, JetBrains Mono. A separate matching-browser adapter probe reports Apple / Metal 3 and `isFallbackAdapter: false` ([probe](gpu-probe.json)).

Each condition uses 128 warmup updates and 20 alternating baseline/candidate pairs of 128 updates per side. Both isolated Wasm instances receive identical, precomputed UTF-8 inputs. Every counted pipeline update submits a render; GPU completion is awaited after every 32 submissions and at block end. Text, geometry, input hashes, frame counts, and unchanged source/artifact hashes are checked. Generation and validation are outside timing.

| Workload          | Before updates/s | After updates/s | Median paired gain | Paired ratio P10–P90 |
| ----------------- | ---------------: | --------------: | -----------------: | -------------------: |
| Dense truecolor   |              552 |             807 |             +46.5% |         1.430–1.494× |
| Style/glyph churn |              396 |             502 |             +26.2% |         1.247–1.297× |
| Dashboard         |              950 |           1,160 |             +23.0% |         1.198–1.287× |
| 3D Pipes          |              244 |             276 |             +14.1% |         1.131–1.161× |
| Scrolling logs    |            3,282 |           3,368 |              +1.0% |         0.988–1.047× |

Rates and ratios use the upper middle observation for 20 samples. The paired gain is calculated per matched block and therefore need not equal the ratio of the two displayed medians. P10/P90 describe paired-run spread, not confidence intervals.

| Parse-only workload | Median paired speedup |
| ------------------- | --------------------: |
| Dense truecolor     |                 1.84× |
| Style/glyph churn   |                 1.35× |
| Dashboard           |                 1.47× |
| 3D Pipes            |                 1.15× |

Scrolling-log parse blocks are shorter than 1 ms and heavily quantized by the browser timer; no parser improvement is claimed for that case. The pipeline log result also spans parity.

At DPR 2, dense throughput increases **44.1%** (607 → 874 updates/s); dashboards increase **21.8%** (939 → 1,112). These are separate paired runs, so their absolute rates should not be compared with DPR 1 as a scaling experiment.

Raw evidence: [DPR 1 runs](final-dpr1/runs.json), [DPR 1 summary](final-dpr1/summary.json), [DPR 2 runs](final-dpr2/runs.json), [DPR 2 summary](final-dpr2/summary.json).

This measures GPU-completed update throughput, not physical display FPS or end-to-end `Wraith.mount()` write latency. The host was shared; OS load is recorded per condition, but thermal state, CPU frequency and other applications were not controlled. Wraith builds, profiling and our upstream test processes did not run during these timed blocks. Dashboards and logs exceed 1,000 updates/s in these measured blocks; dense and Pipes workloads remain below that target.

## What changed

1. **SGR batching** (`76bdae0`). The upstream parser still decodes every attribute. Screen style values are updated in order, then the final style is interned once. Intermediate states are never printed. Direct attribute callers and handlers without the batch method retain the original path. Failed batch commits restore state and replay the ordinary best-effort actions. The patch is pinned to the upstream revision and exact input/output file hashes; unknown edits fail closed.
2. **Bulk row extraction** (`d06e87a`). Ordinary raw cells come from the existing public row view. The cell iterator is positioned only when style, background or grapheme data needs it. No private cell bit layout is assumed, and the iterator fallback remains available.

The separate [SGR pilot](sgr-pilot/summary.json) measured about 43% dense and 13% Pipes pipeline gains. The extraction [pilot](bridge-pilot/summary.json) and [longer confirmation](bridge-confirm/summary.json) compared against the SGR-only artifact: an additional 1–3% on dense/churn/dashboard scenes, essentially neutral for Pipes and logs. Those stages use different block/history settings; the final table above is the matched combined result.

**Rejected:** retained Rust input buffers, copied from a JavaScript `Uint8Array`, did not reliably outperform wasm-bindgen’s current per-write allocation path. The dense paired median was +0.3%, Pipes −0.2%, with both spreads crossing parity. This prototype is not shipped. Its [patch](input-buffer-prototype.patch), [raw runs](input-pilot/runs.json) and [summary](input-pilot/summary.json) are preserved. Apply the prototype to the SGR-only implementation to reproduce it.

The separate [native CPU profile](profile-before.json) identified style lookup, comparison, hashing and registration as roughly half the sampled Pipes self-time. Symbols were resolved only after every noncustom section of a named Wasm build matched the profiled binary byte for byte. The original profiler’s xterm-specific group labels were not used.

## Correctness and build evidence

- Engine/SDK/demo builds, Binaryen optimization, formatting, TypeScript checking, 44 Rust tests and 33 Vitest tests passed.
- [Differential corpus](differential.json): 23,469 fragments, 810 state snapshots and 239,760 cell comparisons against the original artifact. Covers fragmented UTF-8/CSI, malformed SGR, colors, saved cursors, modes, replies/events, alternate screens and 6,000 unique styles under scrolling.
- [Pixel parity](incremental-pixels.json): 60 incremental frames across native and compatible profiles at DPR 1/2 are byte-identical. Covers row reuse, scrolling, selection, indexed/truecolor styles, wide/combining glyphs, underlines and alternate screens. The harness asserts that baseline artifact interception actually ran.
- Native worker/browser integration and packed consumers passed in Vite development and production. Compatible API/addon/fallback and packed-consumer checks passed on the SGR artifact; both-profile pixel checks also passed after extraction changed.
- Upstream Debug suite: 6,122 passed and 114 skipped. The initial 32 snapshot failures were all missing fixture paths caused by the wrong working directory. Rerunning `terminal.snapshot` and the new `batched SGR` tests from the Ghostty checkout passed 323 checks, skipped two and failed none, including all previously failing fixtures. The new tests cover ordered style equivalence, cursor style IDs/reference preservation, no-op batches and style-map growth.
- The differential corpus does not separately fault-inject the batch handler’s allocation-failure fallback. No claim of exhaustive OOM equivalence is made. Full [validation record](validation.json).

## Reproduce

Baseline code: `bfeb2dedc2c67a912fd4d10e1c24a1c8ecf179a7`. Final implementation: `d06e87a`. The raw JSON records full artifact and source hashes. Baseline Wasm SHA-256: `40f031244d3a09bf16c51ea7064f31ad2e33f3962889ebc6b4899dfe1ef4f552`. Final Wasm: `c517a0e8071a38007a9ca65dd72ee70ca944bc5b131306b166e834a008f1cca3`.

Extract the baseline’s four `packages/wraith/wasm/wraith_engine*` files into `.cache/native-pass/baseline/wasm/`, then run from the Wraith checkout:

```sh
npm run build
npm run optimize
node scripts/native-differential.mjs
node scripts/native-paired.mjs
WRAITH_DPR=2 WRAITH_WORKLOADS=complex,showcase WRAITH_STAGES=pipeline \
  WRAITH_REPORT_DIR=.cache/native-pass/retina node scripts/native-paired.mjs
```

`WRAITH_NATIVE_BASELINE` overrides the baseline directory; `WRAITH_PAIRS`, `WRAITH_FRAMES`, `WRAITH_HISTORY`, `WRAITH_DPR`, `WRAITH_WORKLOADS` and `WRAITH_STAGES` control the paired harness. It owns a temporary Vite server on port 5198 and closes it and Chrome at completion. Use `WRAITH_BEFORE_WASM` with `scripts/retained-rows-test.mjs` to route only the first page to the preserved artifact.

For upstream fixture tests, start in `.cache/ghostty` and use absolute tool/cache paths; `--build-file` alone does not set the test process working directory. Full upstream tests require Debug because they explicitly assert `slow_runtime_safety`.
