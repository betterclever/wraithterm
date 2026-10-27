# Command blocks: overhead

Does OSC 133 command-block support slow terminals that never receive OSC 133?
And what does it cost when the marks are present?

Raw data: [overhead-raw.json](overhead-raw.json) (every sample, environment and
hashes). Script: `scripts/command-blocks-benchmark.mjs` (`npm run benchmark:commands`).

## Setup

- Apple M5 Max (Mac17,6), macOS 27.2. Google Chrome 155.0.8059.85, **headless**,
  through Playwright. The Vite dev server ran on 127.0.0.1.
- **Baseline**: origin/main `1151069` (`115106931ce4`). Its SDK was compiled
  from source with its checked-in Wasm (sha256 `8882eda8…`).
- **Current**: branch `feat/command-blocks` at `8814be5`, with the Wasm built
  from this branch (sha256 `58f995cb…`). The benchmark script itself was not
  yet committed, so the report records `dirty: true`. It was committed
  unchanged afterwards.
- `Wraith.mount()`, 120×36 cells, `fit: false`, deviceScaleFactor 1. Every
  sample uses a fresh page. There were 9 runs, and the order of baseline and
  current alternated each run.

Workloads:

- **stream**: 60,000 lines (256-color SGR, 120 columns, ~7.4 MB) written
  through `write()` in ~64 KiB chunks. Then `flush()` renders and waits for a
  GPU fence. The time covers parsing plus the final GPU-completed render, not
  display presentation.
- **scroll**: `term.benchmark({ workload: 'scroll', frames: 2000, warmup: 128 })`.
  Its frames are GPU-completed submissions, fenced every 32. They are not
  displayed frames.
- **stream + OSC 133** (current only): the same stream, split into 600 command
  blocks (A/B/C/D marks every 100 lines).

## Results (medians of 9)

| Build    | Workload           | Stream MiB/s | Scroll GPU-fenced frames/s | Scroll CPU p50 / p95 |
| -------- | ------------------ | -----------: | -------------------------: | -------------------: |
| baseline | no OSC 133         |        177.1 |                      9,264 |      0.1 ms / 0.2 ms |
| current  | no OSC 133         |        177.5 |                      9,137 |      0.1 ms / 0.2 ms |
| current  | 600 OSC 133 blocks |        150.7 |                          — |                    — |

Per-run spread (sorted):

- Baseline stream MiB/s: 171, 172, 173, 175, 177, 178, 178, 180, 182.
  Scroll frames/s: 8,977–9,662.
- Current stream MiB/s: 173, 175, 177, 177, 178, 178, 180, 182, 185.
  Scroll frames/s: 9,066–9,492.

## Reading

- **No OSC 133**: stream throughput is unchanged (medians within 0.3%). The
  scroll medians differ by 1.4%, well inside the run-to-run ranges, which
  overlap almost entirely. This matches the design: without a mark, the only
  new work is one unset-callback check in Ghostty and one boolean check per
  frame in the worker. Within this noise, we measured no overhead. That does
  not prove the cost is exactly zero.
- **With OSC 133**: streaming the same bytes as 600 blocks runs at ~85% of
  plain throughput (49.8 ms vs 42.1 ms median). The extra time is tracked-ref
  creation, Ghostty's pin bookkeeping as pages are pruned, encoding each
  completion, and posting gutter extents. A first version that re-read every
  block on each completion was quadratic. It ran at 52 MiB/s in a single smoke
  run, and that pass was replaced before these measurements.
- One headless run on one machine. Headed Chrome, other GPUs and other
  browsers were not measured.
