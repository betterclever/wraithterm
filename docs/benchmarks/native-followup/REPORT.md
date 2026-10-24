# Native cell decoding follow-up — 17 October 2026

The generated cell decoder adds **3.5% dense**, **2.8% style/glyph churn**, and **3.7% dashboard GPU-completed throughput** over the already optimized native/libghostty build from `d38e149`. Pipes and scrolling-log gains are inconclusive. This is an incremental improvement, not a 2× result, and it does not change the xterm-compatible parser.

## Confirmed decoder results

Apple M5 Max, 18 logical CPUs, Chrome 155, hardware Apple/Metal 3 WebGPU (`isFallbackAdapter: false`), 240 × 80 cells, DPR 1, 2,000 scrollback lines, JetBrains Mono. The final decoder run used 128 warmup updates and 20 alternating baseline/candidate pairs of **256 updates per side**. Both modules receive identical precomputed UTF-8 inputs; every pipeline update submits a frame, with GPU completion awaited every 32 submissions and at block end. Input generation and state validation are excluded from timing.

| Workload          | Before updates/s | After updates/s | Median paired change | Paired ratio P10–P90 |
| ----------------- | ---------------: | --------------: | -------------------: | -------------------: |
| Dense truecolor   |              861 |             891 |                +3.5% |         1.023–1.063× |
| Style/glyph churn |              526 |             543 |                +2.8% |         1.017–1.051× |
| Dashboard         |            1,167 |           1,217 |                +3.7% |         1.008–1.057× |
| 3D Pipes          |              272 |             273 |  +0.7%, inconclusive |         0.937–1.034× |
| Scrolling logs    |            1,678 |           1,790 |  +4.0%, inconclusive |         0.976–1.151× |

Rates use the upper middle of 20 observations. Ratios are computed per matched pair, so their median need not equal the ratio of the displayed rate medians. P10/P90 describe observed spread, not confidence intervals. These are GPU-completed update rates, not physical display FPS or end-to-end worker/API latency.

Raw evidence: [final decoder runs](abi-post-encoding/runs.json), [summary](abi-post-encoding/summary.json). Earlier [128-update pilot](abi-pilot/summary.json) and [512-update confirmation](abi-confirm/summary.json) overlapped substantial unrelated video encoding and browser activity; their raw runs are retained alongside the summaries. The 512-update run still suggested 4–5% median gains but had wide spread. The final repeat began after those encoders finished. Other applications remained active; CPU frequency, thermals, and GPU activity were not held fixed. Logs remained noisy even in that repeat, so no log speedup is claimed. Absolute rates should not be compared with previous reports as if host conditions were identical.

## Implementation

Commit `445b7b2` replaces four generic per-cell queries with inline reads generated from libghostty's public `ghostty_type_json()` manifest. The build extracts that manifest from the **exact target archive being linked**, separately for native and Wasm. It validates the schema, types, enum values, bit widths, nesting and non-overlapping offsets; C static assertions also check the headers. No private layout is hardcoded or assumed stable between upstream versions.

Both builds compare the generated readers against the linked library's public getters on **100,130 raw cells**, including single-bit patterns, their complements and deterministic random values. Codepoint reads preserve the distinction between text/grapheme and background-only cells. Style and grapheme lookups still use the existing public APIs, and the iterator fallback and retained-row rules are unchanged.

The baseline [dense profile](profile-dense.json) attributed 17.2% of sampled self-time to `Core::update`; the [Pipes profile](profile-pipes.json) still showed substantial style lookup/comparison cost. Symbol attribution was accepted only after all noncustom Wasm sections matched the profiled artifact byte-for-byte. The profiler's xterm-specific category labels were not used for these native results.

## Experiments

A four-lane SIMD-style equality representation did not reliably improve either parsing or the pipeline: dense pipeline 0.988×, Pipes 0.998×, churn 1.006×, with all observed spreads crossing parity. It was rejected. [Prototype](equality-prototype.patch), [runs](equality-pilot/runs.json), [summary](equality-pilot/summary.json). The original implementation already used packed 128-bit equality on Wasm; SIMD was already enabled in the build.

Forcing style equality to inline also failed to produce a reliable gain over the decoder build: dense pipeline 1.002×, Pipes 1.001×, churn 1.000×, with spreads crossing parity. It added 2,776 bytes to the optimized Wasm and was rejected. The 20-pair, 256-update experiment passed the same differential corpus. [Prototype](style-inline-prototype.patch), [runs](inline-pilot/runs.json), [summary](inline-pilot/summary.json).

### Parked: SGR parser inlining

Commit `5d6043c` tested inlining the existing SGR iterator. Against the decoder-only build, the [512-update confirmation](sgr-inline-confirm/summary.json) showed +5.7% dense parse throughput and +2.9% dense pipeline throughput. The [combined experimental sweep](final-combined/summary.json), against the start-of-pass artifact, measured +6.3% dense, +3.1% churn and +4.8% dashboard pipeline medians. **Those are not the shipped results.**

That full sweep also showed **10.3% lower Pipes parse throughput**, with the candidate slower in every one of the 20 pairs (ratio P10–P90: 0.847–0.952×). Pipeline Pipes was noisy. A direct [inlining-versus-decoder repeat](pipes-regression-check/summary.json) did not reproduce the slowdown: parse median 1.046×, P10–P90 0.932–1.206×. Further isolated comparisons found [decoder versus original](pipes-abi-recheck/summary.json) at 0.995× and [inlined versus original](pipes-final-recheck/summary.json) at 1.028×, both with spread across parity. Unrelated encoding and browser activity continued on the shared host.

The discrepancy is unresolved. It is not evidence that Pipes is reliably slower, but the full-sweep result is too consistent to dismiss. **The SGR inlining change was therefore removed from the default build.** The source [prototype](sgr-inline-prototype.patch), commit, raw runs and [experimental validation](inlined-validation/validation.json) remain available. It passed the differential/pixel/browser/consumer checks and all 129 focused upstream SGR tests ([log](upstream-sgr-tests.txt)); the decision to park it is about performance, not a known semantic failure. This avoids selecting only the favorable runs.

## Correctness

- Engine, SDK and demo builds, Binaryen optimization, TypeScript checking and Rust formatting passed. The demo retains its existing large-chunk warning.
- 44 Rust tests and 45 Vitest tests passed, including 12 ABI schema/offset guard checks. The extra 129 upstream SGR checks and multi-patch fixture tests belong to the parked experiment, as recorded above.
- [Differential corpus](differential.json): 23,469 input fragments, 810 snapshots and 239,760 cell comparisons matched the previous optimized native artifact.
- [Pixel parity](incremental-pixels.json): 60 byte-identical GPU frames across both terminal profiles at DPR 1 and 2.
- Native worker/browser checks and 20 compatible API/addon/fallback checks passed. Both installed npm archives passed Vite development and production checks. Wasm integration passed stream-boundary, effect, alternate-screen and allocation-lifetime checks.

[Validation record](validation.json). DPR 2 here is a correctness check; this pass does not claim a measured Retina throughput improvement. Browser test benchmark numbers are smoke checks, not the controlled comparison above.

## Reproduce

Baseline commit: `d38e14967b66c79a0661ea5d162a1e590719429d`.
Baseline Wasm SHA-256: `c517a0e8071a38007a9ca65dd72ee70ca944bc5b131306b166e834a008f1cca3`.
Shipped decoder implementation: `445b7b2`. The later SGR inlining commit `5d6043c` was reverted by `1ab639c`; its results are experimental.
Decoder Wasm SHA-256: `e279c2da3755e4df0742ff76b975f520240ec9bc035008eae808e8ae382d73d1`.
Parked inlined Wasm SHA-256: `a8a43a8fc9a064268b97b35e6e614590029d513e56a9d05b20d60698649b9183`. The final shipping Wasm is the decoder artifact above.

Preserve the baseline's four `packages/wraith/wasm/wraith_engine*` files in `.cache/native-next/baseline/wasm`, then run:

```sh
npm run build
npm run optimize
WRAITH_NATIVE_BASELINE=.cache/native-next/baseline/wasm \
  WRAITH_REPORT_DIR=.cache/native-next/differential \
  node scripts/native-differential.mjs
WRAITH_NATIVE_BASELINE=.cache/native-next/baseline/wasm \
  WRAITH_FRAMES=256 WRAITH_STAGES=pipeline \
  WRAITH_REPORT_DIR=.cache/native-next/reproduction \
  node scripts/native-paired.mjs
```

`WRAITH_NATIVE_CANDIDATE` can select a saved candidate directory without replacing the installed artifact. The paired harness now fingerprints the ABI generator and probes for a hardware GPU before timing. `WRAITH_EXTRA_SOURCES` accepts comma-separated repository-relative paths so experimental upstream-cache edits are also checked for changes during a run. Raw JSON records artifact/source hashes, input hashes, browser identity, hardware and OS load. This test owns a temporary Vite server on port 5198 and closes it and Chrome when finished.
