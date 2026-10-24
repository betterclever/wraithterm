# Many terminals in one tab

Apple M5 Max, Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36, headed on the built-in 120 Hz display (each run re-measured the display at 117–121 Hz). Build `64c1d7a`; Wasm, SDK, page and runner hashes and every run are in [results.json](results.json).

Each terminal is 80×24, in a grid filling a 1600×900 window at DPR 2, streaming two coloured agent-log lines and a rewritten status row per update. Each writes its next update once the previous one is parsed and a display frame passes, as an app would. Frames are counted from each terminal's own render callback (Wraith `onRender`, xterm.js `onRender`) over 8 s after a 2 s warm-up. Three rounds rotate the renderer order, with a fresh browser per run. Memory is the summed resident memory of that browser's processes, sampled mid-run. Unrelated desktop work (a polling `git status`, a second Chrome) ran throughout.

| Terminals | Renderer                  | Terminals drawing |                                    Render callbacks / terminal / s |       Mount | Chrome memory |
| --------: | ------------------------- | ----------------: | -----------------------------------------------------------------: | ----------: | ------------: |
|        16 | Wraith pooled (4 workers) |          16 of 16 |                                                            120–120 |   63–134 ms | 1.47–1.48 GiB |
|        16 | Wraith dedicated          |          16 of 16 |                                                            119–120 |  112–156 ms | 1.77–1.79 GiB |
|        16 | xterm.js + WebGL          |          16 of 16 |                                                            120–120 |  102–146 ms | 1.25–1.27 GiB |
|        64 | Wraith pooled (4 workers) |          64 of 64 |                                                             85–108 |  193–337 ms | 1.57–1.63 GiB |
|        64 | Wraith dedicated          |          64 of 64 |                                                              80–95 |  317–583 ms | 3.26–3.39 GiB |
|        64 | xterm.js + WebGL          |          16 of 64 |                                                            102–120 |  370–616 ms | 1.47–1.50 GiB |
|       128 | Wraith pooled (4 workers) |        128 of 128 |                                                              48–55 |  334–472 ms | 1.78–1.87 GiB |
|       128 | Wraith dedicated          |                 — | out of memory: cannot instantiate another Wasm instance (3/3 runs) |           — |             — |
|       128 | xterm.js + WebGL          |         16 of 128 |                                                              57–72 | 711–1157 ms | 1.55–1.63 GiB |

Chrome keeps about 16 live WebGL contexts per page. Beyond that, xterm.js WebGL terminals lose their renderer: their canvases stop drawing while writes and render callbacks continue, so their callback rate overstates what is on screen. Dedicated Wraith runs one worker, Wasm instance and GPU device per terminal and cannot instantiate 128. The pool runs every terminal at 128 on four workers and about 1.9 GiB.

## Limits

Render callbacks are submissions, not physical display frames. Terminals in one pooled worker share its thread. At 128 terminals more workers did not raise the frame rate (8 and 9 workers measured 34–35 in a headless probe, like 4), which points at compositing 128 separate canvases rather than worker CPU. Each canvas is still its own surface; a shared-surface renderer is future work.

Reproduce with the demo server running: `HEADED=1 WRAITH_URL=http://127.0.0.1:5173 node scripts/pool-benchmark.mjs`.
