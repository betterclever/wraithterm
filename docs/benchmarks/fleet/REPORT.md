# Fleet: shared surface vs per-canvas pool

## Update: 1,000 terminals at 60+ updates per second (#67)

Apple M5 Max (18 cores), macOS 27.2, Chrome 156.0.0.0 (`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36`). All runs are **headed** on the built-in display at 120 Hz (idle rAF re-measured after each run: 120–121 Hz), on AC power and wrapped in `caffeinate -u -d`; an idle-dimmed display drops Chrome to 30 Hz. Measured 2026-10-28 between 07:23 and 07:53 IST. The machine's 1-minute load average was 3.4–12.3 and is recorded per run. Unrelated work (a zcash node, other sessions) ran throughout; no other benchmark ran at the same time.

The page build is `d0d7f5a`. Only documentation drafts were uncommitted (`dirty` in each JSON). The `sources` hashes describe the runner's checkout (`d0d7f5a`, Wasm SHA-256 `9f20bd5c…`). For the baseline and HUD comparisons, the page under test came from the build named in `build`, served from its own worktree.

The method is the one described below for #54, with 4 workers, plus a second feed:

- **main**: the #54 driver. One main-thread `requestAnimationFrame` loop writes each terminal's next update once its previous `write()` resolved, at most once per display frame.
- **worker**: each pool worker replays its terminals' updates itself (64 precomputed `logUpdate` chunks per terminal), one per terminal per worker animation frame. Nothing crosses the main thread while terminals stream. This is the agent-dashboard case, where each worker owns its terminals' sockets.

**LoAF** is the total of Long Animation Frames over 50 ms in the 8 s window. **Browser CPU** is the CPU time of all browser processes divided by wall time. Ranges are min–max over 3 rounds.

### After (`d0d7f5a`), 4 workers ([60fps-after-w4.json](60fps-after-w4.json))

| Terminals | Feed   | Parsed / terminal / s |         p10 | GPU-completed / terminal / s | Page rAF / s | Long tasks | LoAF | Browser CPU (cores) | RSS (GiB) |  Load 1m |
| --------: | ------ | --------------------: | ----------: | ---------------------------: | -----------: | ---------: | ---: | ------------------: | --------: | -------: |
|       256 | main   |           119.9–120.1 | 119.9–120.1 |                  118.1–118.2 |        120.1 |          0 |    0 |                 1.6 |      1.85 | 3.4–10.3 |
|       256 | worker |           119.9–120.1 | 119.9–120.1 |                  118.1–118.2 |  119.9–120.1 |          0 |    0 |                 1.4 |      1.74 | 3.4–11.3 |
|       512 | main   |                 120.0 |       120.0 |                  117.7–117.9 |        120.0 |          0 |    0 |             2.7–2.9 |      2.34 |  4.0–8.5 |
|       512 | worker |                 120.0 |       120.0 |                  118.0–118.2 |        120.0 |          0 |    0 |                 2.4 | 2.20–2.29 |  4.2–9.4 |
|     1,000 | main   |            73.9–115.8 |  73.7–115.5 |                   76.6–114.5 |  119.5–119.9 |          0 |    0 |             4.2–5.3 | 3.14–3.20 |  4.4–9.7 |
|     1,000 | worker |            83.3–119.1 |  83.2–119.0 |                   85.1–123.2 |        120.0 |          0 |    0 |             4.1–4.8 | 3.08–3.19 |  5.0–9.4 |
|     1,500 | main   |             50.6–59.5 |   50.2–59.1 |                    49.4–58.3 |  119.2–119.8 |          0 |    0 |             4.1–4.5 |      3.99 | 5.7–10.2 |
|     1,500 | worker |             63.7–74.5 |   63.4–74.3 |                    61.6–73.0 |  119.6–119.9 |          0 |    0 |             5.0–5.2 | 3.96–4.04 |  5.8–9.4 |
|     2,000 | main   |             41.8–45.3 |   41.2–44.8 |                    42.1–46.8 |  118.9–119.6 |          0 |    0 |             5.1–5.2 | 3.96–4.62 | 5.7–10.0 |
|     2,000 | worker |             47.1–49.5 |   46.8–49.1 |                    46.8–49.5 |  119.0–120.0 |          0 |    0 |                 5.2 | 4.77–4.86 | 7.8–12.3 |

### Before: #54 (`f0a8486`), 4 workers, main feed ([60fps-before-w4.json](60fps-before-w4.json))

#54 has no worker-fed mode. These runs were measured in the same session as the table above, at load 6.3–7.6.

| Terminals | Parsed / terminal / s |         p10 | GPU-completed / terminal / s | Page rAF / s | Long tasks | Browser CPU (cores) | RSS (GiB) |
| --------: | --------------------: | ----------: | ---------------------------: | -----------: | ---------: | ------------------: | --------: |
|       256 |                 119.9 | 119.5–119.6 |                  117.8–118.0 |  119.8–120.0 |          0 |                 3.0 |      1.96 |
|       512 |            87.1–102.6 |   83.2–99.2 |                   90.1–105.6 |  118.9–119.9 |          0 |                 5.5 | 2.55–2.60 |
|     1,000 |             46.3–47.9 |   43.0–44.7 |                    46.8–48.8 |    82.0–85.5 |          0 |                 5.8 |      3.30 |
|     1,500 |             33.3–34.1 |   30.4–31.3 |                    32.8–33.6 |    53.3–55.1 |          0 |                 5.7 |      3.74 |
|     2,000 |             27.0–27.5 |   24.5–24.9 |                    27.9–28.4 |    40.8–42.0 |          0 |                 5.7 | 4.31–4.45 |

### After, 6 workers ([60fps-after-w6.json](60fps-after-w6.json))

| Terminals | Feed   | Parsed / terminal / s |         p10 | GPU-completed / terminal / s | Page rAF / s | Long tasks | Browser CPU (cores) | RSS (GiB) | Load 1m |
| --------: | ------ | --------------------: | ----------: | ---------------------------: | -----------: | ---------: | ------------------: | --------: | ------: |
|       256 | main   |           119.9–120.1 | 119.9–120.1 |                        118.1 |  119.9–120.1 |          0 |                 1.9 |      1.90 | 7.3–8.9 |
|       256 | worker |                 120.0 |       120.0 |                  118.0–118.2 |        120.0 |          0 |                 1.7 |      1.80 | 6.4–8.4 |
|       512 | main   |           119.4–120.0 | 119.4–120.0 |                  117.4–118.1 |  119.4–120.0 |          0 |                 2.9 |      2.36 | 6.3–7.9 |
|       512 | worker |           119.1–120.1 | 119.1–120.1 |                  117.1–118.1 |  119.1–120.1 |          0 |             2.5–2.6 |      2.23 | 6.0–8.1 |
|     1,000 | main   |           102.8–107.7 |  99.5–105.9 |                  101.2–104.6 |  117.9–118.8 |          0 |             5.7–7.2 |      3.26 | 5.9–8.8 |
|     1,000 | worker |           105.9–109.7 | 105.7–109.2 |                  110.3–112.9 |  117.1–119.2 |          0 |             5.2–6.3 |      3.19 | 6.5–8.9 |
|     1,500 | main   |             58.2–59.9 |   57.8–59.1 |                    55.8–57.8 |  117.0–119.4 |          0 |             6.1–6.3 |      4.07 | 6.8–9.3 |
|     1,500 | worker |             72.2–72.5 |   70.9–72.0 |                    69.1–72.2 |  112.4–114.4 |          0 |                 6.9 |      4.00 | 7.5–9.4 |
|     2,000 | main   |             46.0–46.4 |   45.4–46.1 |                    45.4–47.2 |  100.4–102.7 |          0 |                 6.8 | 4.94–5.02 | 8.5–9.1 |
|     2,000 | worker |             55.2–55.6 |   54.6–54.8 |                    55.7–56.2 |   99.8–107.2 |          0 |             7.0–7.2 |      4.86 | 8.4–8.8 |

**The highest count where every terminal held ≥ 60 updates per second (p10 ≥ 60 in all 3 rounds):**

- **1,000 terminals, in both feeds.** With 4 workers, p10 was 73.7–115.5 driven from the main thread and 83.2–119.0 fed in the workers. #54 reached 43.0–44.7. The display held 120 Hz in every 1,000-terminal run.
- **1,500 terminals, worker-fed only.** p10 was 63.4–74.3 with 4 workers and 70.9–72.0 with 6. Driven from the main thread, 1,500 terminals reached 50–59.
- **Not 2,000.** The best case was worker-fed with 6 workers, at p10 54.6–54.8.

At 1,000 terminals the spread between rounds follows machine load. Round 0 ran at load 4–6: p10 115.5 (main) and 119.0 (worker). Round 1 ran at load about 9, while an unrelated node process held a core: 73.7 and 83.2. Rely on the lower end.

### Where the time went

These are Chrome traces of headed 1,000-terminal runs (`npm run profile:fleet`, 2 s windows, sampled self time per thread). The raw traces are hundreds of MB and are not committed.

1. **#54:** the main thread was 98% busy.
   - Placement measured every terminal every frame. In 2 s that cost `getBoundingClientRect` 315–508 ms, `checkVisibility` 159–278 ms, the loop about 300 ms, and about 0.3–0.5 s of forced style and layout.
   - About 2,000 port messages per frame took most of the rest: `MessagePort::Accept`, serialization and task dispatch.
   - Workers were about 46% busy.
2. **Batching pooled messages** raised page rAF from 69 to 96. Placement was still the limit.
3. **Measuring placement only when something can move it** cut placement to about 0.1 s per 2 s. The workers became the limit.
   - A named Wasm build showed `wraith_row_reuse` on top.
   - Scrolled rows copied every cell through a derived `clone_from`, which allocates a `String` per cell.
   - Row keys went through a temporary `Vec`, and raw rows were compared with a byte-at-a-time `memcmp` on wasm32.
4. **At 1,500–2,000 terminals, the GPU process and Chrome's layerization took over.**
   - CrGpuMain was up to 99% busy, mostly in `CommandBufferService:PutChanged`.
   - `PaintArtifactCompositor::Update` took 2–3 s per window.
   - The layer tree of a 256-terminal page had 1,041 compositor layers. 768 of them were hidden input textareas: a user-scrollable textarea is a composited scroller with scroller, contents and scrollbar layers.
   - Every drawn terminal issued its own `writeBuffer` and re-set the pipeline three times per frame.
5. **After all changes,** a 1,000-terminal page has 17 layers. No measured run had long tasks or Long Animation Frames, and page rAF stayed at 120.

### Changes, one commit each

| Change                                                                                | Commit    |
| ------------------------------------------------------------------------------------- | --------- |
| Engine: scrolled rows reuse buffers (`Cell`/`RowKey` `clone_from`, word-wise compare) | `4e1ab98` |
| One command batch per worker per task and one reply batch back                        | `9338774` |
| Placement by observation (`sharedSurface.tracking`, `pool.updatePlacements()`)        | `54aed01` |
| Fleet HUD on one stable line                                                          | `30ae285` |
| Worker-fed benchmark mode, profiler and run metadata                                  | `b7a6c79` |
| IME preedit span shown only while composing                                           | `d7cd18d` |
| Long Animation Frame attribution                                                      | `2b794b7` |
| Hidden textarea `overflow: hidden` (no per-terminal compositor layers)                | `f8af694` |
| `contain: layout paint style` on terminal elements                                    | `0492fa0` |
| `WriteArena` (one write buffer per worker batch)                                      | `96369eb` |
| Stats only while observed, one display heartbeat, one listener per worker             | `96369eb` |
| Shared uniform ring (one `writeBuffer` per surface frame), pipeline set once per pass | `4e089f1` |

### Single runs between steps

These are single 8 s runs at 1,000 terminals, mostly under heavy unrelated load ([60fps-steps-single-runs.json](60fps-steps-single-runs.json)). They show direction only.

| Build         | Workers |   Load 1m | Main: parsed / p10 / page rAF | Worker: parsed / p10 / page rAF |
| ------------- | ------: | --------: | ----------------------------- | ------------------------------- |
| #54 `f0a8486` |       4 | 10.5–11.3 | 41.5–44.3 / 38.2–40.9 / 72–77 | —                               |
| `f8af694`     |       6 |    90–116 | 53.5 / 48.6 / 85.5            | 56.1 / 55.6 / 95.0              |
| `96369eb`     |       6 |     61–69 | 63.0 / 62.3 / 102.1           | 61.6 / 61.3 / 106.8             |
| `4e089f1`     |       6 |   105–114 | 75.5 / 74.3 / 115.9           | 83.7 / 83.3 / 114.9             |

### HUD fix

These runs used 1,000 terminals, main feed, 4 workers and 3 rounds each. Raw data: [54aed01](60fps-hud-54aed01.json), [30ae285](60fps-hud-30ae285.json), [tip](60fps-hud-tip.json), [tip with the old HUD](60fps-hud-tip-oldhud.json).

| Page                                              | p10         | Page rAF / s | Long tasks per 8 s |
| ------------------------------------------------- | ----------- | ------------ | ------------------ |
| `54aed01`, before the HUD commit                  | 66.5–69.3   | 102.7–103.4  | 0                  |
| `30ae285`, the HUD commit alone                   | 47.2–48.1   | 57.7–59.6    | 3,977–4,047 ms     |
| `d0d7f5a` tip                                     | 110.2–115.6 | 119.9–120.0  | 0                  |
| `d0d7f5a` tip with the pre-fix HUD CSS and markup | 111.1–115.5 | 119.9–120.0  | 0                  |

Measured on its own commit, the HUD change slowed that page, adding about 4 s of long tasks per window. This is consistent with layerization: at that commit every terminal still had three textarea layers, and the contained, backdrop-filtered HUD changed how they were layerized. After the textarea fix, the HUD markup makes no measurable difference. The fix is kept for its stable layout (readouts no longer re-wrap the HUD or move the grid), not as a performance claim.

### Limits

- The worker-fed mode replays precomputed chunks inside the worker. It measures workers that own their terminals' streams (for example `terminal.connect(url)`) without a network or server in the loop.
- For shared pools, per-terminal "submitted" now comes from worker surface counters, because per-terminal stats are only posted while observed. The #54 baseline used per-terminal stats.
- In earlier runs, before the textarea fix, 8 workers made Chrome's layerization take 0.3–1 s per update at 1,500 terminals. #54 showed the same. 8 workers were not re-measured after the fix.
- Chrome's canvas swap chain still creates and destroys shared images each frame. Page code cannot change that.

Reproduce with `HEADED=1 WRAITH_URL=http://127.0.0.1:5173 MODES=shared FEEDS=main,worker WORKERS=4 COUNTS=256,512,1000,1500,2000 caffeinate -u -d npm run benchmark:fleet`. `BUILD` and `RESULTS` label another build, and `npm run profile:fleet` records traces.

## Effects on the shared surface (#68)

Measured at 1,000 shared terminals with 4 workers. Each effect setting was applied with `pool.setEffects()` before mounting, and every setting was measured in both feeds over 3 rounds. The build was `42ff896` (clean tree); the session and conditions match the update above (07:47–07:51 IST, load 5.5–9.4, AC power). Raw runs are in [effects-w4.json](effects-w4.json). Each run also records every surface's `effectPasses`, which confirms the effects were active: 0 with effects off, 3 for CRT + bloom (two bloom blur passes and the composite) and 4 with synthwave added (plus the custom-shader pass).

| Feed   | Effects                 | Parsed / terminal / s |        p10 | GPU-completed / terminal / s | Page rAF / s | Long tasks | Browser CPU (cores) | RSS (GiB) | Load 1m |
| ------ | ----------------------- | --------------------: | ---------: | ---------------------------: | -----------: | ---------: | ------------------: | --------: | ------: |
| main   | off                     |            80.5–118.8 | 80.1–118.6 |                   83.6–117.6 |  119.6–120.0 |          0 |             4.4–5.1 | 3.13–3.25 | 5.5–8.9 |
| main   | CRT + bloom             |            81.0–117.8 | 80.8–117.7 |                   84.1–116.7 |  119.1–120.0 |          0 |             4.4–5.5 | 3.16–3.25 | 5.6–7.5 |
| main   | CRT + bloom + synthwave |            89.3–116.7 | 89.0–116.6 |                   92.7–121.0 |  119.5–120.1 |          0 |             4.7–5.4 |      3.15 | 6.6–9.1 |
| worker | off                     |            99.8–119.6 | 99.4–119.5 |                  104.2–123.9 |  120.0–120.1 |          0 |             4.4–4.7 | 3.15–3.21 | 6.9–9.4 |
| worker | CRT + bloom             |            92.9–119.7 | 92.6–119.6 |                   94.5–123.9 |  119.9–120.0 |          0 |             4.2–4.9 | 3.08–3.27 | 7.1–9.0 |
| worker | CRT + bloom + synthwave |            85.8–119.4 | 85.6–119.1 |                   87.8–123.8 |  119.6–120.0 |          0 |             4.2–4.8 | 3.08–3.27 | 6.9–9.1 |

Effects run once per worker surface: three full-surface passes for CRT + bloom, four with synthwave. At 1,000 terminals they cost less than the run-to-run spread caused by machine load: every setting held p10 ≥ 80 in both feeds, and the display held 120 Hz. Device-wide GPU utilization was not sampled, so no GPU-time cost is claimed. GPU-completed counts are reported as above.

## Original #54 measurements

Apple M5 Max, macOS 27.2, Chrome 155.0.0.0 (`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36`), **headed** on the built-in Liquid Retina XDR display at 120 Hz (idle rAF re-measured after each shared run: 118–121 Hz). Build `df8b8db` (clean tree); Wasm, SDK, page and runner SHA-256 hashes and every run are in [results.json](results.json). Measured 2026-10-26.

`demo/fleet.html` mounts N 80×24 terminals (JetBrains Mono 7 px, line height 1.2, scrollback 1,000) on `Wraith.pool({ workers: 4 })` in a 1600×900 CSS-px window at DPR 2, with the grid fitted to the window (so terminals are CSS-scaled below 1:1 in both modes). Every terminal streams `logUpdate` from `demo/rival-bench.js`: two coloured agent-log lines plus a rewritten status row. One `requestAnimationFrame` driver writes each terminal's next update once its previous `write()` has resolved (parsed), at most once per display frame. 3 s warm-up, 8 s window, 3 rounds, mode order alternating, fresh browser per run.

### Results (min–max over 3 runs)

| Terminals | Surface    | Display rAF/s | Updates parsed / terminal / s | p10 terminal | Frames submitted / terminal / s | GPU-completed updates / terminal / s | Presented frames / s per worker | Long tasks | Mount      | Chrome RSS    |
| --------: | ---------- | ------------: | ----------------------------: | -----------: | ------------------------------: | -----------------------------------: | ------------------------------: | ---------: | ---------- | ------------- |
|        64 | shared     |   119.9–120.1 |                   119.9–120.1 |  119.9–120.1 |                     118.7–118.9 |                          118.7–118.9 |                             119 |          0 | 87–95 ms   | 1.44–1.45 GiB |
|        64 | per-canvas |   104.9–107.3 |                    94.9–100.0 |    94.4–99.8 |                       92.9–97.2 |                         not measured |                 64 own canvases |          0 | 188–192 ms | 1.57–1.58 GiB |
|       256 | shared     |   119.8–119.9 |                   119.1–119.7 |  118.6–119.2 |                     117.4–118.3 |                          117.4–118.3 |                             118 |          0 | 167–266 ms | 1.96 GiB      |
|       256 | per-canvas |     42.0–46.7 |                     23.0–27.5 |    22.7–27.0 |                       21.3–25.5 |                         not measured |                256 own canvases |          0 | 651–693 ms | 1.99–2.10 GiB |
|     1,000 | shared     |     69.4–84.1 |                     41.0–49.2 |    38.0–45.8 |                       40.2–48.5 |                            39.5–48.3 |                           61–78 |          0 | 2.1–2.8 s  | 2.94–3.15 GiB |
|     1,000 | per-canvas |     20.1–22.5 |                       5.9–6.8 |      5.9–6.4 |                         5.2–5.9 |                         not measured |              1,000 own canvases |          0 | 2.8–3.3 s  | 1.88–2.40 GiB |

At 1,000 terminals the shared surface sustained 41–49 parsed updates per terminal per second (41,000–49,000 terminal updates per second in one tab) against 5.9–6.8 per-canvas, about 7×. At 256 it held the display rate (119/s) against 23–28. No long tasks (over 50 ms) were recorded on the main thread in any measurement window, in either mode.

### What each column means

- **Display rAF/s** counts main-thread `requestAnimationFrame` callbacks, which shows whether the page keeps up with the display. It is not a capture of physical presentation.
- **Updates parsed** counts resolved `write()` promises, which means bytes parsed by Ghostty in the worker.
- **Frames submitted** is each terminal's Wraith `stats.frames`: render submissions, not display presentation.
- **GPU-completed updates** (shared only) counts terminal updates drawn into surface frames whose GPU work completed (`onSubmittedWorkDone`). It tracks submissions closely (under 2% lower, the in-flight tail), so submitted shared frames did complete on the GPU. Per-canvas pools have no equivalent counter, so their submissions are not reported as GPU-completed.
- **Presented frames** (shared only) are frames each worker copied to its canvas and presented. The per-canvas pool composites one canvas per terminal instead.
- **Chrome RSS** sums resident memory of the browser and all its processes, sampled mid-window. Shared mode used more at 1,000 terminals, from four page-sized canvases with swap chains and backings at 3200×1800 and about 7× the update traffic in flight. Per-canvas atlas textures are not all resident at this workload. Memory is not claimed as an advantage here.

### Notes and limits

- Both modes include the main-thread fix committed with this work: unfocused terminals no longer move their hidden input on every cursor update. Before it, a headless 1,000-terminal shared run spent 2.6 s of every 3 s in Chrome's Layerize step. These per-canvas numbers are therefore better than the previous [pool report](../pool/REPORT.md)'s code would give at the same counts.
- At 1,000 shared terminals the limit is the main thread, not the GPU: 1,000 writes and replies per frame, plus one placement measurement per visible terminal per frame. Surface frames tracked the display rate until the main thread fell below it.
- The idle rAF rate measured right after per-canvas runs was 83–121 Hz, while disposal of hundreds of canvases was still settling. Shared runs re-measured 118–121 Hz.
- Unrelated desktop work ran during the measurements. No number in this table comes from a headless (60 Hz) run.

Reproduce with the demo server running:
`HEADED=1 WRAITH_URL=http://127.0.0.1:5173 npm run benchmark:fleet` (`COUNTS`, `ROUNDS`, `SECONDS`, `WARM` and `OUT` override the defaults).
