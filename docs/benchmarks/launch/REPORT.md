# Launch comparison: Wraith against xterm.js

Measured 10 October 2026 in headless Chrome 155 on macOS (Apple M5 Max), hardware WebGPU,
with `scripts/compare-renderers.mjs`. Two Wraith builds ran in alternating batches, three
rounds each: the first recorded comparison (`5f5b129`) and the launch build (`c6a77bd`,
Wasm SHA-256 `3e0ddeca…`). xterm.js 6.0 with its DOM renderer and WebGL addon 0.19 ran in
the same batches; their results do not depend on the Wraith build and are pooled (six runs
each). These are GPU-completed synthetic updates, not display frames. The native profile is
driven directly, without the SDK's worker transport.

Dense scene, 240×80 cells, about 4,800 style changes per update, DPR 1. Medians:

| Renderer                     | CPU per update (p50) | Redraw (p50) | Updates/s |
| ---------------------------- | -------------------: | -----------: | --------: |
| xterm.js, DOM                |             37.65 ms |     37.25 ms |      25.7 |
| xterm.js + WebGL             |              9.80 ms |      8.80 ms |      93.9 |
| Wraith, xterm-compatible     |              2.50 ms |      0.60 ms |     388.2 |
| Wraith, native (libghostty)  |              3.10 ms |      1.00 ms |     316.8 |
| first recorded build, compat |              4.20 ms |      2.10 ms |     233.3 |
| first recorded build, native |              4.60 ms |      2.30 ms |     214.7 |

The compatible path uses 15× less CPU per update than xterm.js DOM (37.65 / 2.5) and 3.9×
less than xterm.js + WebGL (9.8 / 2.5). These are the figures in the README and the launch
video. This machine was busier than during `docs/benchmarks/comparison`, so absolute numbers
are lower there; compare within one table only. Churn, scroll and DPR 2 results are in
[summary.json](summary.json); every run is in [runs.json](runs.json).

The launch build was later changed to synthesize bold by dilating rasterized coverage. That
runs only on glyph-atlas misses and is not part of the measured warm path.

Reproduce with the demo server running: `WRAITH_DPRS=1 WRAITH_WORKLOADS=complex,churn,scroll
WRAITH_REPETITIONS=3 npm run benchmark:compare`.
