# Screen reader mode: overhead and validation

Apple M5 Max (18 logical CPUs), macOS 27.2 (Darwin 27.2.0), Chrome 155.0.8059.85, **headless**, WebGPU adapter `BrowserWebGpu`. The machine was shared with other build and benchmark jobs during every run: load average 9–14. Throughput was measured on branch build `37c7595`; the later `c252051` changes only when the focus ring shows. Baseline is `main` at `1151069`, the same Wasm engine (`8882eda8…`). Every hash and raw sample is in the JSON files.

## Throughput: screen reader mode off is unchanged

[runs.json](runs.json) comes from `scripts/accessibility-benchmark.mjs`: 5 browser pages × 6 rounds = 30 paired samples per configuration. Each page mounts one visible 160×50 terminal per configuration, from the baseline and branch builds side by side. Every round runs each configuration once, in rotated order. Each value is divided by the baseline measured in the same round, so load drift on the shared machine affects all configurations alike.

| Configuration                      | Bulk write + flush, MiB/s (median) | Paired vs baseline, median (IQR) | Dense, GPU-fenced frames/s | Paired | Scroll, GPU-fenced frames/s | Paired |
| ---------------------------------- | ---------------------------------: | -------------------------------: | -------------------------: | -----: | --------------------------: | -----: |
| baseline `main`, screen reader off |                              266.2 |                            1.000 |                       5538 |  1.000 |                        5623 |  1.000 |
| branch, screen reader off          |                              264.1 |              1.000 (0.984–1.015) |                       5556 |  1.006 |                        5572 |  1.004 |
| branch, screen reader **on**       |                              261.8 |              1.002 (0.986–1.018) |                       5470 |  1.003 |                        5692 |  1.002 |

- **Bulk:** 32 MiB of SGR-coloured log lines in 64 KiB chunks. Each `write()` is awaited until parsed, then `flush()` forces a render and waits on a GPU fence.
- **Dense / scroll:** the built-in `benchmark()`, 512 frames each. These are GPU-fenced submissions, not display presentation.
- **Stream:** 2 s of 40 lines every 16 ms. Median render submissions (`onRender`) were 112, 111 and 113 per 2 s for the three configurations. These are headless `requestAnimationFrame` submissions, not display frames. The longest single `write()` await was 1.0, 0.6 and 0.7 ms.

With screen reader mode off, the branch matches `main` within the run-to-run spread. In the off path the only additions are a call on each worker write message that returns at once, and a boolean in `updateVisibility`. With it on, the paired medians also sit inside that spread. On this shared machine the cost is below what these workloads can resolve, so no throughput cost is claimed either way.

## Cost per sample with screen reader mode on

[sample-cost.json](sample-cost.json) comes from `scripts/accessibility-sample-cost.mjs` (Node 24, the same Wasm engine, headless core). It times the work of one worker sample after new output: the viewport text read (including its snapshot), row split, scroll alignment, announcement diff and mirror patch. The browser runs this in the worker, at most every 100 ms while output changes, and never while the screen is idle.

| Grid    | p50 per sample | p95 per sample | Worker CPU at the 10 samples/s cap |
| ------- | -------------: | -------------: | ---------------------------------: |
| 80×24   |       44–50 µs |       72–89 µs |                          ≈0.5 ms/s |
| 160×50  |     169–208 µs |     205–240 µs |                            ≈2 ms/s |
| 300×100 |     605–701 µs |     671–819 µs |                            ≈7 ms/s |

Ranges cover 1, 10 and a full screen of new lines per sample. The main thread then updates only the changed mirror rows and, at most every 500 ms, one live-region node. That DOM work is not in this table.

## Announcements under a 10 MB burst

[accessibility.json](accessibility.json) holds `npm run test:accessibility` at `c252051`. It wrote 10,550,169 bytes as 64 KiB chunks plus a final line, with `announceInterval` 500 ms. Over the burst and the 1.5 s after it, the live region received exactly **2** announcements:

1. at 106 ms: "Output is arriving quickly. Announcements paused until it settles."
2. at 612 ms: "Output settled." followed by the final two screen rows (`…x` and `burst complete: 10 MB`).

The two were 505.6 ms apart. Partial output was never spoken. The same record covers the remaining checks:

- **axe-core 4.14** (WCAG 2.0/2.1 A and AA plus best-practice): zero violations on `accessibility.html`, on `playground.html` with screen reader mode enabled at runtime, and on `xterm.html` with `screenReaderMode` on.
- **Accessibility tree:** Chrome's tree (CDP `Accessibility.getFullAXTree`) exposes the mirror's list items with exactly the screen's rows, and the `Terminal output` log region.
- **Echo and redraws:** typed echo is not announced, and command output is. A 21-step redrawn progress bar produced 3 announcements: the command line, the bar at 100%, and "Build finished" with the prompt.
- **Keyboard exit:** a plain Tab reaches the application, Escape then Tab leaves the terminal, and Escape then Shift+Tab leaves it backward. The xterm.js profile behaves the same with `screenReaderMode` on.
- **Pause:** no render submissions while paused, while the mirror kept updating.
- **Display preferences:** reduced motion stopped cursor-blink frames (5 → 0 in 2.1 s). Forced colors switched the background to the system color and back.

## Limits

- Headless Chrome on a shared, loaded machine; no display presentation is measured. The benchmark loads modules from the Vite dev server for both builds.
- Automated checks prove structure, ARIA semantics and timing, not a usable spoken experience. No manual VoiceOver, NVDA or JAWS session is recorded here.
- `readText({ scope: 'all' })` selects all, formats and clears the selection in one worker task, so an active user selection is cleared.
- Announcements follow the viewport. While the user is scrolled back into history, new output that does not change the visible rows is not announced.

## Reproduce

With the demo server running on port 5217, build `main` to compare against, then run:

```sh
mkdir -p .cache/a11y-main && git archive origin/main packages/wraith | tar -x -C .cache/a11y-main
npx tsc -p .cache/a11y-main/packages/wraith/tsconfig.json
cp .cache/a11y-main/packages/wraith/src/xterm-parser.js .cache/a11y-main/packages/wraith/dist/
npm run build:sdk
WRAITH_URL=http://127.0.0.1:5217 WRAITH_REPETITIONS=5 WRAITH_ROUNDS=6 \
  WRAITH_BEFORE_ROOT=.cache/a11y-main/packages/wraith WRAITH_BEFORE_HASH=$(git rev-parse origin/main) \
  npm run benchmark:accessibility
node scripts/accessibility-sample-cost.mjs
WRAITH_URL=http://127.0.0.1:5217 WRAITH_REPORT_DIR=docs/benchmarks/accessibility npm run test:accessibility
```
