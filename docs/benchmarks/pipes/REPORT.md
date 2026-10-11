# Pipes / 95: terminal stress comparison

Measured 11 October 2026 on Apple M5 Max, 18 logical CPUs, 48 GiB RAM, Darwin
27.2.0, headless Chrome 155, Apple `metal-3` WebGPU, DPR 1. xterm.js 6.0.0 and
the official WebGL addon 0.19.0. This is a shared development machine, not an
isolated performance lab.

Three repetitions per renderer, with the starting renderer rotated each round.
Each pipeline run contains 256 updates after 32 warmup updates; GPU completion is
fenced every 32 updates and after the final update. Wraith submission counters
verify that every counted frame was submitted. Scene generation is excluded.

| Renderer                 | Median completed updates/s |   Run range | Parse p50 | Redraw p50 | Pipeline CPU p95 |
| ------------------------ | -------------------------: | ----------: | --------: | ---------: | ---------------: |
| Wraith / xterm API       |                      418.3 | 418.0–418.4 |    2.0 ms |     0.2 ms |           2.6 ms |
| xterm.js / WebGL         |                      193.5 | 193.1–195.1 |    2.6 ms |     2.1 ms |           6.0 ms |
| Wraith / libghostty core |                      229.3 | 222.8–236.6 |    3.5 ms |     0.6 ms |           5.1 ms |

Wraith's xterm profile completes **2.16×** as many updates per second as official
xterm WebGL on this workload. All renderers complete successfully. These numbers
are **GPU-completed pipeline throughput**, not physical display FPS, GPU-only
execution time, or CPU/GPU utilization percentages. Public `write`/`onRender`
pacing in the comparison remains approximately 60 callbacks/s on this run.
The native result bypasses the SDK worker and its message transport.

## Workload

- 240×80 terminal cells, with matching 2160×1600 canvases and JetBrains Mono at
  15 CSS pixels in all three renderers.
- 50 generated pipes, 957 straight steps, 548 rounded elbows and 104,916
  software-rasterized triangles. The GPU renders terminal cells, not this mesh.
- Every terminal cell is `▀`; its foreground and background encode two pixels.
  Each stress update contains 19,200 combined foreground/background truecolor
  assignments, two SGR resets and explicit positioning for every row.
- Eight precomputed camera poses, 568,525–573,272 ANSI bytes per frame. Repeating
  background colors are deliberately reassigned. The live lab also provides a
  compact encoding and a 12-bit color mode; this benchmark uses neither.
- This is a heavy RGB parsing and cell-update workload, not a broad terminal
  compatibility suite. The library's other tests cover Unicode, styles and APIs.

All eight byte streams have matching SHA-256 hashes in Node and Chrome for every
renderer. For the initial pose of every run, all **38,400 half-cell center samples
match the expected RGB values exactly**. This validates actual rendered color,
not only the buffer's identical block characters. It does not assert pixel-for-pixel
equality along glyph edges, nor independently capture every timed update.

The warm xterm WebGL atlas contains 40,163 glyph entries over 15 pages, while each
Wraith path records one glyph variant. These are observed cache statistics for
this color-heavy scene, not a claim that all workload differences come from the
atlas. Wraith's 2.0 ms median parsing cost exceeds its 0.2 ms redraw cost here;
the 1,000 completed-update/s target remains open.

## Reproduce and inspect

```sh
npm run dev
# In another terminal:
npm run benchmark:pipes
```

Defaults: three repetitions, 256 pipeline updates. Override `WRAITH_REPETITIONS`,
`WRAITH_FRAMES` (32–4096), `WRAITH_URL`, `CHROME_PATH` or `WRAITH_REPORT_DIR`.
Do not edit benchmark sources during a run; their fingerprints are verified at
completion. Screenshots stay in `.cache/pipes` and are not committed.

- [Raw runs](runs.json): hardware, source hashes, all eight input hashes, canvas
  geometry, distributions, GPU uploads, cache statistics and pacing.
- [Summary](summary.json): medians and ranges.
- [Development browser validation](browser-dev.json) and
  [production browser validation](browser-production.json).

At measurement the generator was committed as `f748fe6`; the new harness changes
were still in the working tree and are identified by their full hashes in
`runs.json`. The SDK and Wasm are unchanged by this demo work. Wasm SHA-256:
`40f031244d3a09bf16c51ea7064f31ad2e33f3962889ebc6b4899dfe1ef4f552`.
