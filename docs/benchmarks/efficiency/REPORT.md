# Efficiency pass: compact cells, row reuse and batched transport

Measured 10 October 2026 in headless Chrome 155 on macOS (Apple M5 Max),
hardware WebGPU. Before is `a136240`; after is `414b3df` (Wasm SHA-256
`3e0ddeca0325316050d5ec9384542e6f0233445ebb74b9327039b54416eea6db`). Runs
alternate between builds, three repetitions per condition, 512 GPU-fenced
updates per run at 240×80. Every counted update submitted a frame, and final
text hashes are identical between builds in every group. These are
GPU-completed synthetic updates, not display FPS. Native figures drive the
engine directly, bypassing SDK/worker transport.

| Profile | Workload | DPR | Before updates/s | After updates/s | Change | Redraw CPU p50, ms | Pipeline CPU p95, ms |
| ------- | -------- | --: | ---------------: | --------------: | -----: | -----------------: | -------------------: |
| compat  | complex  |   1 |              514 |             733 |   +43% |          0.9 → 0.3 |            2.1 → 1.5 |
| native  | complex  |   1 |              410 |             612 |   +49% |          1.3 → 0.5 |            2.5 → 1.7 |
| compat  | churn    |   1 |              504 |             736 |   +46% |          0.9 → 0.3 |            2.1 → 1.5 |
| native  | churn    |   1 |              317 |             429 |   +35% |          1.3 → 0.5 |            3.3 → 2.5 |
| compat  | scroll   |   1 |              378 |             464 |   +23% |          0.9 → 0.3 |            2.2 → 1.7 |
| native  | scroll   |   1 |              460 |             738 |   +60% |          1.3 → 0.5 |            2.2 → 1.4 |
| compat  | append   |   1 |            2,026 |           3,911 |   +93% |          0.4 → 0.2 |            0.5 → 0.3 |
| native  | append   |   1 |            1,349 |           2,638 |   +96% |          0.7 → 0.4 |            0.8 → 0.4 |
| compat  | complex  |   2 |              510 |             727 |   +43% |          0.9 → 0.3 |            2.1 → 1.6 |
| native  | complex  |   2 |              360 |             554 |   +54% |          1.5 → 0.6 |            3.1 → 2.0 |

Medians; before and after ranges do not overlap in any group. `complex`,
`churn` and `scroll` rewrite all 19,200 cells with about 4,800 SGR changes
per update. `append` streams eight styled log lines per update. Timer
resolution is 0.1 ms.

Separately, 20,000 sequential 50-byte writes through `Wraith.mount()` finish
parsing in 16–20 ms instead of 101–106 ms (four alternating runs each).

## What changed

- **20-byte GPU cells.** A glyph word (atlas slot, ink width, color bit)
  replaces four float atlas coordinates. Each update uploads 37.5% fewer cell
  bytes.
- **Glyph quads sized to ink.** Blank cells rasterize nothing in the glyph
  pass, and fragments read flat varyings instead of the storage buffer. GPU
  pass time was not measured separately, so no GPU speedup is claimed.
- **Hash-free glyph lookup.** Scalars below U+3000 index a flat table; other
  clusters use a multiply hash. Native cells carry their scalar, and a
  maintained blink count replaces a per-frame grid scan.
- **Fewer libghostty queries per cell.** One selection range per row, one
  multi-get for content, width, codepoint and style ID, and style decoding
  only when the style ID changes.
- **Row reuse.** The compat renderer keeps the raw xterm words behind each
  staged row; native keys rows by libghostty row ID plus raw cells. Unchanged
  rows are skipped, moved rows are copied, and only changed rows are
  uploaded.
- **Batched SDK writes.** A burst of writes is one worker transfer with one
  acknowledgement.

## Correctness evidence

`scripts/pixel-differential.mjs` renders 58 scenes and fixtures through a
baseline and the current build on both profiles at DPR 1 and 2. They cover
dense scenes, every underline style, strikethrough and overline, all cursor
shapes on blanks and glyphs, italic overhang, wide, combining and emoji
cells, box/block/braille, background-only erase and selection. Every
screenshot is byte-identical. Row reuse is also checked against full repacks
(compat, including every submitted GPU span) and against fresh terminals
(native). A one-cell edit uploads exactly one row.

## Reproduce

Serve the baseline checkout on port 5190 and the current tree on 5173 with
`npm run dev`. Both need the current `demo/compare.js` harness. Then run:

```sh
WRAITH_BASELINE_DIR=<baseline> WRAITH_REPORT_DIR=docs/benchmarks/efficiency \
  WRAITH_TYPES=wraith,ghostty WRAITH_WORKLOADS=complex,churn,scroll,append \
  WRAITH_REPETITIONS=3 WRAITH_FRAMES=512 npm run benchmark:optimization
node scripts/pixel-differential.mjs
```

Raw runs: [optimization.json](optimization.json). Medians and ranges:
[summary.json](summary.json).
