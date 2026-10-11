# Pipes / 95

A Windows-era 3D Pipes stress scene rendered entirely through terminal characters.
Open `http://127.0.0.1:5173/pipes.html` after `npm run dev`. The lab shares the
website's ember theme and the existing playground stylesheet.

The geometry uses seeded lattice walks, cylindrical sweeps, rounded torus elbows,
end caps, perspective projection, a depth buffer and metallic lighting. A worker
software-rasterizes it into two RGB pixels per terminal cell. The terminal receives
only `▀`, standard truecolor SGR, cursor positioning, cursor visibility and wrap
mode sequences. The 3D triangle count describes the software scene; the terminal
renders ordinary glyph cells, not those triangles directly.

## Controls

| Control               | Behavior                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Renderer              | Wraith WebGPU, official xterm WebGL, or xterm DOM. All receive the same generator's ANSI.                                   |
| Classic               | 120×42 cells, up to 12 pipes.                                                                                               |
| Pressure              | 180×60 cells, up to 28 pipes.                                                                                               |
| Inferno               | 240×80 cells, up to 52 pipes; 19,200 cells and 38,400 RGB assignments per stress frame.                                     |
| Prebaked stress loop  | Builds a bounded 48-frame bank in a worker, then plays it forward/backward. Generation is excluded from playback.           |
| Live 3D               | Generates one frame at a time in a worker with a continuously rotating camera. Generation contributes to animation cadence. |
| SGR every cell        | Deliberately sends a complete foreground/background assignment for every cell, including the background.                    |
| Elide repeated colors | Sends the same image while omitting redundant color changes.                                                                |
| 12-bit metal          | Quantizes all pixel channels to 16 levels, reducing distinct color combinations.                                            |
| Seed                  | Reproduces the same network. Occupancy can stop a pipe before its requested length or count.                                |

Changes take effect with **Rebuild scene**. Rebuilding disposes the old terminal
and worker. Playback awaits public `write` and `onRender` before sending another
frame, so slow renderers do not accumulate an unbounded input queue. Hidden pages
stop scheduling frames. Reduced-motion preferences start the scene paused.

The default seed's Inferno scene has 50 pipes, 957 straight steps, 548 rounded
elbows and 104,916 software triangles. Its 48-frame bank is approximately 26 MiB.
Scene generation and ANSI encoding run in JavaScript; Wraith's terminal renderer
remains Rust/Wasm/WebGPU. The live counter reports browser render callbacks,
not physical display FPS or GPU-completed throughput.

## Run in another terminal

From this repository, in a terminal with truecolor support:

```sh
npm run pipes -- --preset inferno
npm run pipes -- --preset pressure --compact --colors rgb444 --fps 30
```

The CLI fits the initial terminal dimensions. Explicit `--cols` and `--rows`
override them; restart after resizing. It honors output backpressure and restores
the alternate screen, cursor and wrap mode on normal exit or Ctrl+C. Use
`--frames` for finite captures; non-interactive output requires it:

```sh
node scripts/pipes.mjs --cols 120 --rows 42 --frames 1 > pipes.ansi
```

The lab's **Download ANSI frame** button also exports a complete portable frame.

## Validation and comparison

```sh
npm test
npm run test:pipes       # requires npm run dev in another terminal
npm run benchmark:pipes
```

Unit tests check exact ANSI foreground/background round trips, no accidental
scrolling, deterministic geometry, depth-order independence, color quantization
and input bounds. Browser checks exercise all three lab renderers, replay/live
switching, cancellation, pause/resume, downloads, desktop/mobile layouts and
reduced motion. Local screenshots are written under `.cache/pipes`.

The comparison harness also includes **3D pipes** at `/compare.html?workload=pipes`.
`benchmark:pipes` drives both Wraith profiles and xterm WebGL sequentially with
identical precomputed frames, checks the screenshot colors against the software
image, waits for GPU completion, and saves source hashes and raw results. Native
measurements drive the libghostty engine directly rather than through its SDK worker.

The [first measured report](benchmarks/pipes/REPORT.md) records 418 vs 193
GPU-completed updates/s for Wraith's xterm profile and xterm WebGL on an M5 Max.
These are workload-specific results; none of the tested renderers crashed.
