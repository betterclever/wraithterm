# Run shaping and ligatures

Apple M5 Max, Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36. Build `40607f0`; Wasm and runner hashes and every run are in [results.json](results.json).

A 160×50 native terminal at DPR 1 runs Wraith's built-in `benchmark()`: 2,048 frames after 128 warm-up, with a GPU fence every 32 frames, in GPU-completed frames per second. Three rounds alternate the order of ligatures off and on.

| Workload | Ligatures off |  Ligatures on |
| -------- | ------------: | ------------: |
| dense    |   5,469–5,579 |   4,087–4,156 |
| scroll   |   5,634–5,833 |   5,710–5,763 |
| sparse   | 13,590–14,163 | 14,252–14,463 |

The dense workload is the worst case for ligatures: every 160-cell row is printable ASCII full of operator characters, and each frame rewrites all rows, so with ligatures on most rows contain fresh operator runs to look up. Shaped runs are cached, so steady text pays only a hash lookup per run. With ligatures off, rows without complex-script text take the original per-cell path plus one comparison per cell. In alternating pairs against the previous engine, dense throughput with ligatures off stayed within run-to-run variation (5,540–5,772 against 5,412–5,657 frames/s).

These are GPU-completed frames, not display FPS.

Reproduce with the demo server running: `WRAITH_URL=http://127.0.0.1:5173/playground.html node scripts/shaping-benchmark.mjs`.
