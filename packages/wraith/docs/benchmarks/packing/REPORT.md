# Bulk row packing and persistent Wasm staging

Measured 10 October 2026 using hardware WebGPU in headless Chrome. This pass
compares the previously optimized xterm-compatible renderer with guarded bulk
row reads and compositor-owned Wasm staging. The native profile is a control;
its semantic core and rendering path were not optimized in this pass.

The scene is 240 by 80 cells, eight Unicode/style variants, roughly 210 KiB of
input and 4800 style changes per update. Parse, redraw, and complete pipeline
work use the existing comparison method. These are GPU-completed synthetic
updates, not physical display FPS. Native figures bypass SDK/worker transport.

## Combined results

Three alternating repetitions cover four conditions and two profiles, totaling
48 runs. Each counted pipeline frame actually submitted, and paired final text
hashes agree. Full ranges and every run are retained in staging-pass.

| Profile | Workload | DPR | Before updates/s | After updates/s |  Change | Redraw CPU p50 before / after, ms |
| ------- | -------- | --: | ---------------: | --------------: | ------: | --------------------------------: |
| wraith  | complex  |   1 |           271.65 |          301.53 | +11.00% |                       1.60 / 1.30 |
| ghostty | complex  |   1 |           405.32 |          411.44 |  +1.51% |                       1.30 / 1.30 |
| wraith  | churn    |   1 |           279.29 |          304.25 |  +8.94% |                       1.60 / 1.30 |
| ghostty | churn    |   1 |           312.04 |          313.26 |  +0.39% |                       1.30 / 1.40 |
| wraith  | scroll   |   1 |           229.31 |          244.74 |  +6.73% |                       1.60 / 1.30 |
| ghostty | scroll   |   1 |           463.10 |          463.94 |  +0.18% |                       1.30 / 1.30 |
| wraith  | complex  |   2 |           275.03 |          301.39 |  +9.58% |                       1.60 / 1.30 |
| ghostty | complex  |   2 |           405.96 |          407.38 |  +0.35% |                       1.30 / 1.30 |

Compatible pipeline throughput improves by approximately 7 to 11% in these
comparisons. Median redraw CPU time falls from 1.6 to 1.3 ms, a reduction of
18.75%. Native throughput changes are small and are not claimed as optimization
wins. Outliers remain in the records. Absolute rates varied substantially across
benchmark batches; compare paired builds within the same batch rather than
combining the new values with historical rates from other sessions.

## Separate effects

The row-reader-only pass, using the unchanged C999 engine, recorded six runs:
416.26 to 459.44 median updates/s (+10.37%), with redraw CPU p50 1.2 to 1.0 ms.
Its ordinary-scalar fixture performs zero public cell loads. Combined text,
extended attributes, invalid scalars, and unfamiliar row storage keep getters.

The additional staging change removes three binding allocations and array copies
per compatible redraw. At 19200 cells it avoids a 614400-byte cell copy plus
48 bytes of dimension/frame copying into Wasm; GPU upload copies remain.

Its isolated speed effect is inconclusive on this busy machine. The first
three short pairs report a -2.38% difference between aggregate medians, while
individual pair ratios range from -3.02% to +3.74%. A follow-up uses five pairs
of 1024-frame pipelines: aggregate medians move from 344.02 to 361.62 updates/s
(+5.12%), but paired effects include gains and regressions with large rate
variation. Both datasets are preserved. This report does not claim a uniform
additional throughput improvement from staging alone.

## Ownership and correctness

The compositor owns initialized cell slots plus a 12-word uniform region.
JavaScript fills views between synchronous calls, then submits a bounded count
and destination offset. Views refresh after configuration or memory growth.
When cold glyph upload grows memory during packing, the affected row repeats
before submission. Reserved uniforms reset after a resize. GPU storage limits
are validated before arena allocation.

Validation passed: 35 Rust tests, 15 Vitest tests, 22 exact GPU-word/text/state
fixtures at DPR 1 and 2, 18 xterm browser checks, native GPU browser checks,
strict TypeScript, SDK/demo builds, wasm Clippy with warnings denied, and Rust
and JavaScript formatting. Browser checks force invalid counts and uniforms,
pre-frame growth, and growth during a cold glyph upload; they compare the exact
words actually submitted. Both packed npm consumers pass Vite development and
production tests, including unchanged xterm imports and original addons.

1000 updates/s is not established for this complex scene. Retained GPU rows,
compact glyph descriptors, parser work, and GPU support for common fallback
features remain the next larger investments.

## Evidence and reproduction

- [Row-only records](row-pass/summary.json).
- [Combined raw runs](staging-pass/optimization.json) and [summary](staging-pass/summary.json).
- [Exact differential checks](staging-pass/renderer-differential.json).
- [Short staging-only runs](staging-isolated/optimization.json).
- [Long staging-only runs](staging-isolated-long/optimization.json).

The unchanged checkout is retained locally at work/packing-baseline, served at 5190. The row-only commit 3cfd61e is retained at work/row-packing-baseline, served
at 5191. Current build runs at 5173. Untimed fixture helpers are synchronized
for selection-event delivery; baseline runtime source and Wasm remain unchanged.

```sh
WRAITH_BASELINE_DIR=../../work/packing-baseline WRAITH_REPORT_DIR=docs/benchmarks/packing/staging-pass npm run benchmark:optimization
WRAITH_REPORT_DIR=docs/benchmarks/packing/staging-pass node scripts/renderer-differential.mjs
WRAITH_BASELINE_DIR=../../work/row-packing-baseline WRAITH_BEFORE_URL=http://127.0.0.1:5191 WRAITH_REPORT_DIR=docs/benchmarks/packing/staging-isolated-long WRAITH_TYPES=wraith WRAITH_DPRS=1 WRAITH_WORKLOADS=complex WRAITH_REPETITIONS=5 WRAITH_FRAMES=1024 npm run benchmark:optimization
```

Before engine SHA-256: `c9991d95b022a8ab9643a9e2f4e84e1af4ba80fd363135f79804e40dc3a2c986`.

After engine SHA-256: `c0fbfda9394b415511d5fa4882512b39d0b55136e87ba99356ec203fdfc45795`.
