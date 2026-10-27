# Fleet: shared surface vs per-canvas pool

Apple M5 Max, macOS 27.2, Chrome 155.0.0.0 (`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36`), **headed** on the built-in Liquid Retina XDR display at 120 Hz (idle rAF re-measured after each shared run: 118–121 Hz). Build `df8b8db` (clean tree); Wasm, SDK, page and runner SHA-256 hashes and every run are in [results.json](results.json). Measured 2026-10-26.

`demo/fleet.html` mounts N 80×24 terminals (JetBrains Mono 7 px, line height 1.2, scrollback 1,000) on `Wraith.pool({ workers: 4 })` in a 1600×900 CSS-px window at DPR 2, with the grid fitted to the window (so terminals are CSS-scaled below 1:1 in both modes). Every terminal streams `logUpdate` from `demo/rival-bench.js`: two coloured agent-log lines plus a rewritten status row. One `requestAnimationFrame` driver writes each terminal's next update once its previous `write()` has resolved (parsed), at most once per display frame. 3 s warm-up, 8 s window, 3 rounds, mode order alternating, fresh browser per run.

## Results (min–max over 3 runs)

| Terminals | Surface    | Display rAF/s | Updates parsed / terminal / s | p10 terminal | Frames submitted / terminal / s | GPU-completed updates / terminal / s | Presented frames / s per worker | Long tasks | Mount      | Chrome RSS    |
| --------: | ---------- | ------------: | ----------------------------: | -----------: | ------------------------------: | -----------------------------------: | ------------------------------: | ---------: | ---------- | ------------- |
|        64 | shared     |   119.9–120.1 |                   119.9–120.1 |  119.9–120.1 |                     118.7–118.9 |                          118.7–118.9 |                             119 |          0 | 87–95 ms   | 1.44–1.45 GiB |
|        64 | per-canvas |   104.9–107.3 |                    94.9–100.0 |    94.4–99.8 |                       92.9–97.2 |                         not measured |                 64 own canvases |          0 | 188–192 ms | 1.57–1.58 GiB |
|       256 | shared     |   119.8–119.9 |                   119.1–119.7 |  118.6–119.2 |                     117.4–118.3 |                          117.4–118.3 |                             118 |          0 | 167–266 ms | 1.96 GiB      |
|       256 | per-canvas |     42.0–46.7 |                     23.0–27.5 |    22.7–27.0 |                       21.3–25.5 |                         not measured |                256 own canvases |          0 | 651–693 ms | 1.99–2.10 GiB |
|     1,000 | shared     |     69.4–84.1 |                     41.0–49.2 |    38.0–45.8 |                       40.2–48.5 |                            39.5–48.3 |                           61–78 |          0 | 2.1–2.8 s  | 2.94–3.15 GiB |
|     1,000 | per-canvas |     20.1–22.5 |                       5.9–6.8 |      5.9–6.4 |                         5.2–5.9 |                         not measured |              1,000 own canvases |          0 | 2.8–3.3 s  | 1.88–2.40 GiB |

At 1,000 terminals the shared surface sustained 41–49 parsed updates per terminal per second (41,000–49,000 terminal updates per second in one tab) against 5.9–6.8 per-canvas, about 7×. At 256 it held the display rate (119/s) against 23–28. No long tasks (over 50 ms) were recorded on the main thread in any measurement window, in either mode.

## What each column means

- **Display rAF/s** counts main-thread `requestAnimationFrame` callbacks, which shows whether the page keeps up with the display. It is not a capture of physical presentation.
- **Updates parsed** counts resolved `write()` promises, which means bytes parsed by Ghostty in the worker.
- **Frames submitted** is each terminal's Wraith `stats.frames`: render submissions, not display presentation.
- **GPU-completed updates** (shared only) counts terminal updates drawn into surface frames whose GPU work completed (`onSubmittedWorkDone`). It tracks submissions closely (under 2% lower, the in-flight tail), so submitted shared frames did complete on the GPU. Per-canvas pools have no equivalent counter, so their submissions are not reported as GPU-completed.
- **Presented frames** (shared only) are frames each worker copied to its canvas and presented. The per-canvas pool composites one canvas per terminal instead.
- **Chrome RSS** sums resident memory of the browser and all its processes, sampled mid-window. Shared mode used more at 1,000 terminals, from four page-sized canvases with swap chains and backings at 3200×1800 and about 7× the update traffic in flight. Per-canvas atlas textures are not all resident at this workload. Memory is not claimed as an advantage here.

## Notes and limits

- Both modes include the main-thread fix committed with this work: unfocused terminals no longer move their hidden input on every cursor update. Before it, a headless 1,000-terminal shared run spent 2.6 s of every 3 s in Chrome's Layerize step. These per-canvas numbers are therefore better than the previous [pool report](../pool/REPORT.md)'s code would give at the same counts.
- At 1,000 shared terminals the limit is the main thread, not the GPU: 1,000 writes and replies per frame, plus one placement measurement per visible terminal per frame. Surface frames tracked the display rate until the main thread fell below it.
- The idle rAF rate measured right after per-canvas runs was 83–121 Hz, while disposal of hundreds of canvases was still settling. Shared runs re-measured 118–121 Hz.
- Unrelated desktop work ran during the measurements. No number in this table comes from a headless (60 Hz) run.

Reproduce with the demo server running:
`HEADED=1 WRAITH_URL=http://127.0.0.1:5173 npm run benchmark:fleet` (`COUNTS`, `ROUNDS`, `SECONDS`, `WARM` and `OUT` override the defaults).
