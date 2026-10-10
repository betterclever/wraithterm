# Allocation, glyph lookup and presentation optimization

Measured 10 October 2026 in Chrome 155 on the Apple M5 Max machine. These are synthetic GPU-fenced pipeline updates, not physical display FPS. The grid is 240×80, with 19,200 cells, 4,800 style changes and roughly 210 KiB of input per update.

Three repetitions per condition alternate the saved before build and final after build. The same font and geometry are used; 48 runs cover dense content, RGB churn and scrolling/full repaint at DPR 1, plus dense content at DPR 2. Actual submission counters confirm every counted WebGPU pipeline update submitted a frame. All paired final-text hashes agree.

| Profile                | Workload | DPR | Before updates/s | After updates/s | Change | Before redraw CPU p50 | After redraw CPU p50 | After pipeline CPU p95 |
| ---------------------- | -------- | --: | ---------------: | --------------: | -----: | --------------------: | -------------------: | ---------------------: |
| Compatible Terminal    | complex  |   1 |            295.7 |           438.5 | +48.3% |               2.30 ms |              1.10 ms |                2.50 ms |
| Direct libghostty core | complex  |   1 |            357.9 |           395.1 | +10.4% |               1.60 ms |              1.40 ms |                2.60 ms |
| Compatible Terminal    | churn    |   1 |            292.7 |           437.6 | +49.5% |               2.30 ms |              1.20 ms |                2.60 ms |
| Direct libghostty core | churn    |   1 |            282.1 |           305.4 |  +8.3% |               1.60 ms |              1.40 ms |                3.50 ms |
| Compatible Terminal    | scroll   |   1 |            239.7 |           326.9 | +36.4% |               2.30 ms |              1.10 ms |                2.60 ms |
| Direct libghostty core | scroll   |   1 |            400.4 |           444.9 | +11.1% |               1.60 ms |              1.40 ms |                2.40 ms |
| Compatible Terminal    | complex  |   2 |            293.0 |           425.7 | +45.3% |               2.30 ms |              1.20 ms |                2.70 ms |
| Direct libghostty core | complex  |   2 |            353.1 |           387.8 |  +9.8% |               1.60 ms |              1.40 ms |                2.80 ms |

These numbers compare this turn’s saved build against the final build. They do not compare today’s Wraith result with an xterm result from a different run. Native figures exclude SDK/worker transport. Complete ranges and every repetition are retained; the RGB-churn results include an after-run outlier. This is one busy machine, not an isolated multi-device guarantee.

## What changed

Native atlas preflight uses borrowed keys and excludes non-rendered spaces. Compatibility packing reuses buffers, avoids redundant clearing, reuses one ordinary attribute run, and caches scalar glyphs numerically. Combining strings and extended attributes retain their existing handling. The scalar and string maps reference the same tile variants and reset together. Neither style reuse nor glyph caching depends on foreground color.

Failed presentation now retains native damage and pending presentation until a frame is submitted. The worker schedules a retry without another write, except while synchronized output holds the frame. The compatible renderer requests another redraw on a false compositor result. A browser regression simulates the first render returning false.

## Correctness checks

32 native Rust tests and 15 Vitest tests pass. The browser suite covers real GPU pixels, xterm state/selection/reflow, original addons, parser hooks, keyboard events, fallback/failure/disposal, and transient presentation retry. Fourteen before/after differential fixtures compare every packed GPU word at DPR 1 and 2, including palette/RGB/inverse styles, extended underline colors sharing header words, wide and combining cells, emoji, erased text, selection, theme changes, and getter fallback when private words are unavailable. The checked private words belong to the pinned xterm 6.0 boundary.

## Continuous CPU usage on the final build

Two 8-second runs at each target rate, with stationary before/after sampling. CPU sums the dedicated benchmark Chrome processes; 100% is one occupied logical CPU. Machine capacity divides by the 18 logical CPUs and is not an energy-weighted measure.

| Target updates/s | Achieved updates/s | CPU % | Nominal machine capacity % | Whole-device GPU % | Stationary GPU baseline % |
| ---------------: | -----------------: | ----: | -------------------------: | -----------------: | ------------------------: |
|               30 |              29.99 | 22.86 |                       1.27 |              57.57 |                     56.50 |
|              120 |             119.98 | 50.70 |                       2.82 |              63.57 |                     56.25 |

At 30 updates/s, total Chrome CPU usage remains approximately the same as the earlier 22.9% observation; no significant low-rate CPU reduction is claimed. The optimized pipeline has more headroom at high rates. The 120-target loop includes nested browser timer delays and GPU fences and now submits approximately 120 updates/s. It still does not certify public-API or physical 120 Hz presentation. Whole-device GPU counters include other apps, so neither their differences nor GPU-process CPU time are presented as Wraith GPU utilization.

1000 updates/s is not achieved on this dense scene. The next priorities are [GPU feature coverage, retained rows, latency, recovery, memory and integration](../../TOP_TIER.md).

## Evidence and reproduction

Raw speed records: [optimization.json](optimization.json). Aggregates and ranges: [summary.json](summary.json). Exact packed-output checks: [renderer-differential.json](renderer-differential.json). CPU/GPU samples: [usage-after/utilization.json](usage-after/utilization.json). The earlier attribute/buffer-only pass is retained under allocation-pass and uses its own source/binary hashes.

Preserve an unchanged copy of demo, SDK source, Wasm, CSS and root Vite/package metadata before editing; install its dependencies and serve it at port 5190. This local comparison used the retained work/top-tier-baseline snapshot. Run the current demo at port 5173, then:

```sh
npm run benchmark:optimization
node scripts/renderer-differential.mjs
WRAITH_USAGE_TYPES=wraith WRAITH_USAGE_RATES=30,120 WRAITH_USAGE_MS=8000 WRAITH_IDLE_MS=3000 WRAITH_REPORT_DIR=docs/benchmarks/optimization/usage-after npm run benchmark:usage
```

Configure WRAITH_BASELINE_DIR, WRAITH_BEFORE_URL, WRAITH_URL, WRAITH_REPORT_DIR, WRAITH_REPETITIONS and CHROME_PATH as needed. The differential harness requires the same packedFixture helper in both demo copies. Counters/fixtures run outside the timed pipeline. GPU completion is checked in batches of 32 updates.

Before Wasm SHA-256: 4f2da3be7622c81dc8e72625619b440b1570ed2e555692d2d0a2fefd8657e928.

After Wasm SHA-256: c9991d95b022a8ab9643a9e2f4e84e1af4ba80fd363135f79804e40dc3a2c986.
