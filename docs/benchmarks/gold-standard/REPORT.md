# Production performance pass — 17 October 2026

The production xterm-compatible input path now batches numeric parameters and
prints ordinary fixed-width runs directly into the pinned xterm cell layout.
The original dispatcher, hooks and async continuation remain intact. UTF-8,
nontrivial Unicode, wrapping, accessibility, charsets, custom Unicode providers,
insert mode and extended attributes retain upstream behavior.

The generated dispatcher is derived at build time from hash-checked xterm 6.0.0
MIT source, without runtime evaluation. Its upstream license remains packaged.
Single ASCII and box/block drawing characters join the fast path, which matters
for truecolor half-block graphics. This changes the compatible profile, not the
native libghostty parser or Wasm engine.

## Same-device paired measurements

Apple M5 Max, headless Chrome 155, hardware Apple/Metal 3, 240×80 cells. Forty
rotated baseline/params/combined triplets per condition; 32 updates per block,
256 warmup updates per action. Each block counts every submission and waits for
GPU completion. These are completed updates, not physical display FPS. Sources,
Wasm hash and raw samples are recorded in [input/runs.json](input/runs.json).

| Workload | Baseline updates/s | Combined updates/s | Median paired gain |
| --- | ---: | ---: | ---: |
| Dense / DPR 1 | 842 | 891 | 5.9% |
| RGB churn / DPR 1 | 833 | 877 | 5.3% |
| Logs / DPR 1 | 6,531 | 6,809 | inconclusive |
| Dashboard / DPR 1 | 1,306 | 1,488 | 13.9% |
| Pipes / DPR 1 | 435 | 455 | 4.2% |
| Dense / DPR 2 | 714 | 777 | 8.0% |

Rates are medians of individual blocks. Gains are medians of within-triplet
ratios, so they need not equal the ratio of rate medians. Logs have wide paired
variation spanning regressions and gains; no log improvement is established.
The full distributions are in [input/summary.json](input/summary.json). This is
a shared machine and short-block throughput, not long-term stability evidence.
The dense 1,000-update/s target remains open.

The earlier [ASCII-only candidate](ascii/summary.json) improved dense/dashboard
but not Pipes. Its full raw batch is retained; the wider fixed-width path was
measured in a separate batch and must be compared with its own paired baseline.

## Validation

- 31 SDK/demo tests, strict TypeScript, SDK and production demo builds pass.
- Production imports pass the existing upstream differential corpus: 16,554
  fragments, 336 state snapshots, all four async hook kinds, fragmented UTF-8,
  malformed/overflow CSI, custom width providers and reset during continuation.
- All 160 box/block codepoints additionally exercise combining suffixes,
  wide-cell repair and right-margin wrapping against upstream.
- All 20 Chrome xterm API checks pass, including hooks, addons, resource disposal,
  memory growth, retained rows and renderer fallback.
- 22 packed-word differentials match the preserved baseline at DPR 1/2.
- Packed npm alias consumers pass Vite development and production, preserving
  original `@xterm/xterm` imports and addons.

Before build: `ea398b1`. Wasm remains
`40f031244d3a09bf16c51ea7064f31ad2e33f3962889ebc6b4899dfe1ef4f552`.
No CPU/GPU utilization measurement ran alongside throughput.

Run `npm run build:sdk`, `npm run test:input` and, with the demo server running,
`node scripts/paired-production-input.mjs` to reproduce the production actions.
