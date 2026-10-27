# 0.5 recheck: Wraith against xterm.js

Measured 25 October 2026 in headless Chrome 155 on macOS (Apple M5 Max), hardware WebGPU, with `scripts/compare-renderers.mjs`. Build `1151069` with the optimized engine (Wasm SHA-256 `8882eda8…`), byte-identical to the Wasm in the published `wraithterm@0.5.0` package. xterm.js 6.0 with its DOM renderer and WebGL addon 0.19. Two batches of three interleaved rounds: [batch-1.json](batch-1.json) and [batch-2.json](batch-2.json). Every run verified text, canvas geometry and pixels.

Another project's Vite build, a second Chrome and a Codex session ran during both batches. These are GPU-completed synthetic updates, not display frames. The native profile is driven directly, without the SDK's worker transport.

Dense scene, 240×80 cells, about 4,800 style changes per update, DPR 1. Medians of six runs:

| Renderer                    | CPU per update (p50) | Run range | Redraw (p50) | Updates/s |
| --------------------------- | -------------------: | --------: | -----------: | --------: |
| xterm.js, DOM               |              20.4 ms | 18.7–27.3 |      19.0 ms |        47 |
| xterm.js + WebGL            |              5.05 ms |   4.1–8.8 |      3.85 ms |       154 |
| Wraith, xterm-compatible    |               1.1 ms |   1.1–1.3 |       0.3 ms |       862 |
| Wraith, native (libghostty) |               1.1 ms |   1.1–1.3 |       0.5 ms |       879 |

The compatible path uses 4.6× less CPU per update than xterm.js + WebGL (5.05 / 1.1) and 18× less than xterm.js DOM (20.4 / 1.1). The launch comparison measured 3.9× and 15× on build `c6a77bd` ([launch](../launch/REPORT.md)).

xterm.js also measured faster than on 10 October, when that report notes the machine was busier, so compare ratios within one batch rather than absolute times across reports.

Other workloads, CPU per update (p50), six runs each:

| Workload            | xterm DOM | xterm WebGL | Wraith compatible | Wraith native |
| ------------------- | --------: | ----------: | ----------------: | ------------: |
| RGB churn           |   21.8 ms |      4.7 ms |            1.1 ms |        1.9 ms |
| Scrolling log lines |  19.85 ms |     6.15 ms |           1.25 ms |        1.1 ms |

Structural claims on the site, rechecked on this build:

- **20 bytes per GPU cell.** `crates/wraith-engine/src/gpu.rs` asserts `CELL_BYTES == 20` at compile time, so a 240×80 screen is 384,000 bytes (375 KiB).
- **One row uploaded for a one-cell edit.** `npm run test:xterm` asserts that a one-cell edit uploads `cols × 20` bytes and a cursor-only update uploads none. It passed against this build.

Reproduce with the demo server running:

```sh
WRAITH_URL=http://127.0.0.1:5173 WRAITH_DPRS=1 WRAITH_WORKLOADS=complex,churn,scroll WRAITH_REPETITIONS=3 WRAITH_REPORT_DIR=out npm run benchmark:compare
```

Run `npm run build` and `npm run optimize` first so the measured Wasm matches the published package.
