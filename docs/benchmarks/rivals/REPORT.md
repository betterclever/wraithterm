# Wraith, wterm and xterm.js on the same workloads

Apple M5 Max, Chrome 155 (Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36), headed on the built-in 120 Hz display (each run re-measured the display at 120–122 Hz). Build `92f6c8f` (wraithterm 0.5.0), `@wterm/dom` and `@wterm/ghostty` 0.5.5, `@xterm/xterm` 6.0.0 with `@xterm/addon-webgl` 0.19.0. Wasm, page and runner hashes and every run are in [results.json](results.json). The page hash there is from before Prettier wrapped one line of `demo/rival-bench.js`; the code is otherwise identical.

Renderers:

- **Wraith**: native profile, `Wraith.mount()`. Multi-terminal scenarios use `Wraith.pool({ workers: 4 })`.
- **wterm**: `WTerm` with its built-in core.
- **wterm + Ghostty**: `WTerm` with `GhosttyCore` from `@wterm/ghostty`, which also decodes Kitty graphics.
- **xterm.js + WebGL**: `Terminal` with `WebglAddon`.

## Method

Terminals fill a 1600×900 window at DPR 2 in a grid. All four renderers get the same font size, JetBrains Mono, and line height 1. wterm reads its sizing from CSS variables (`--term-font-size`, `--term-row-height`), so those are set directly and its default 12 px padding is removed. Measured drawing areas for one 160×50 terminal: Wraith 800×425, xterm.js 720×500, wterm 800×450 CSS px.

Each terminal writes its next update once the previous one has been processed and a display frame has passed, as an app would. Counts run for 8 s after a 2 s warm-up, and a fresh browser is used per run. Three rounds rotate the renderer order. Frames are counted as follows:

- **Wraith and xterm.js**: render callbacks, capped by updates written.
- **wterm**: completed write-and-frame cycles. wterm renders synchronously on the main thread in its own animation frame, so a cycle completes only after that render.

| Scenario                                                      | Renderer           |     Frames / terminal / s |      Mount |
| ------------------------------------------------------------- | ------------------ | ------------------------: | ---------: |
| 1 × 160×50, truecolor halfblock scene, every cell every frame | Wraith             |                   120–120 |   46–50 ms |
|                                                               | xterm.js + WebGL   |                   120–120 |   14–15 ms |
|                                                               | wterm              |                     24–25 |     6–7 ms |
|                                                               | wterm + Ghostty    |                     24–24 |     8–9 ms |
| 16 × 80×24, halfblock wall                                    | Wraith (pooled)    |                   120–120 |  90–102 ms |
|                                                               | xterm.js + WebGL   |                   118–120 |  97–107 ms |
|                                                               | wterm              |                   6.1–6.2 |   19–21 ms |
|                                                               | wterm + Ghostty    |                   4.8–5.0 |   23–26 ms |
| 64 × 80×24, streaming agent logs                              | Wraith (pooled)    |                    98–115 | 173–189 ms |
|                                                               | xterm.js + WebGL ¹ | 115–120, 16 of 64 drawing | 357–370 ms |
|                                                               | wterm              |                     10–12 |   81–98 ms |
|                                                               | wterm + Ghostty ²  |                 10.5–11.4 |   85–89 ms |
| 1 × 160×45, recorded DOOM, 640×400 Kitty image per frame      | Wraith             |                   115–120 |   47–55 ms |
|                                                               | wterm + Ghostty    |                     13–30 |    8–12 ms |

¹ Chrome keeps about 16 live WebGL contexts per page. 48 of xterm.js's 64 terminals lost their renderer, so their callbacks continue while their canvases stop drawing. One of three runs was lost to a page reload; two runs are shown.

² One of three runs was lost to a page reload; two runs are shown.

Wraith is at the 120 Hz display limit in every scenario except 64 streaming terminals. On the same frames, wterm with either core runs at 1/5 of that for one full-screen terminal, 1/20 to 1/25 for a 16-terminal wall, and 1/10 for 64 log streams. Both terminals decode the same DOOM Kitty stream (checked by screenshot): Wraith draws 115–120 frames per second, wterm + Ghostty 13–30.

## Limits

These workloads change every cell or stream continuously; they measure throughput and frame pacing, not typing latency. wterm's design trades throughput for other things a DOM renderer gives:

- It mounts 5–7× faster for a single terminal.
- It ships no WebGPU or WebGL requirement.
- It exposes real DOM text for selection, find, and accessibility.

A mostly idle shell will look identical in all four. Wraith's figures are render submissions, not physical display frames, and wterm's are completed frame cycles; both are capped by the display. Unrelated desktop work ran during the runs.

Reproduce with the demo server running:

```sh
HEADED=1 ROUNDS=3 DOOM=path/to/kitty-640x400.ansi WRAITH_URL=http://127.0.0.1:5173 node scripts/rival-benchmark.mjs
```

The DOOM stream is a doomterm Kitty recording (`a=T,f=24,s=640,v=400,c=160,r=45`) and is not checked in. `SHOTS=1` saves each run's last frame next to the results.
