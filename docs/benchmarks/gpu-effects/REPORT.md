# GPU effects cost

What each opt-in post-process effect adds to a terminal update at 160x50, DPR 2
(canvas 1760x1250 physical pixels).

## Setup

- Hardware: Apple M5 Max, macOS 27.2
- Browser: Google Chrome 155, headless (`HeadlessChrome/155.0.0.0`), WebGPU adapter
  `BrowserWebGpu`
- Build: commit `48d4bff`, clean tree, optimized Wasm sha256
  `33a992c21660797980e149cb95182ef7029493e2ddfbb98949574afc01093fa3`
- Command: `WRAITH_URL=http://127.0.0.1:5214 node scripts/effects-benchmark.mjs`
- Raw runs: [`chrome-headless-dpr2.json`](chrome-headless-dpr2.json)

Each configuration runs the public `term.benchmark()` path: write, parse, pack,
submit the terminal pass and the effect passes, with a GPU fence every 32
submissions. 512 frames after 64 warmup frames, 3 interleaved rounds, median
reported. These are **GPU-completed updates per second**, not display frames.
The display presents at most one frame per refresh no matter how many updates
complete.

`sparse` updates one row per frame, so it is bound by GPU work and shows
the effect cost. `dense` rewrites all 8,000 cells per frame and is bound by
parsing and packing on the CPU, which hides most of the effect cost.

## Results

| Effects               | sparse updates/s | ms/update | added ms | dense updates/s | added ms |
| --------------------- | ---------------: | --------: | -------: | --------------: | -------: |
| off                   |           13,028 |    0.0768 |        — |           5,535 |        — |
| CRT                   |            9,552 |    0.1047 |   +0.028 |           5,407 |   +0.004 |
| bloom 0.6             |            7,388 |    0.1354 |   +0.059 |           5,161 |   +0.013 |
| cursor trail (idle)   |           10,364 |    0.0965 |   +0.020 |           5,535 |   +0.000 |
| CRT + bloom + trail   |            7,121 |    0.1404 |   +0.064 |           5,182 |   +0.012 |
| custom shader: amber  |            9,660 |    0.1035 |   +0.027 |           5,367 |   +0.006 |
| custom shader: glitch |           10,020 |    0.0998 |   +0.023 |           5,441 |   +0.003 |
| all built-ins + amber |            5,825 |    0.1717 |   +0.095 |           4,468 |   +0.043 |

"added ms" is the difference in reciprocal throughput from `off`. It measures
pipelined throughput cost, not the latency of one frame. Even with every
effect on, one update completes in about 0.17 ms, about 2% of an 8.3 ms
frame at 120 Hz.

The benchmark hides the cursor, so the trail row shows the cost of the extra
scene texture and the composite pass, without drawing the trail itself. The
glitch shader was measured with `animate: false`. Each effect run renders the
terminal pass into a scene texture and then runs its post passes: CRT, the
trail and custom shaders take one full-screen pass each, and bloom adds two
half-resolution blur passes. The built-ins share one composite pass.

## Idle and animation frames

Counted from `onRender` (render submissions) over wall-clock windows
(`animation` in the JSON):

| State                           | frames/s |
| ------------------------------- | -------: |
| effects off, idle               |        0 |
| static CRT + bloom, idle        |        0 |
| iTime shader (glitch) animating |     59.7 |

Static effects request no frames when nothing changes. An animated shader
requests one frame per `requestAnimationFrame`. Headless Chrome runs those at
60 Hz, so this rate is not the refresh rate of a physical display. Frames that
only advance an animation reuse the retained scene texture and run the post
passes alone.

## Effects off

With effects off the renderer holds no effect state (`Option<Effects>` is
`None`): no scene texture, pipelines or extra passes. `npm run
test:native-effects` checks that turning effects on and then off restores
byte-identical pixels. With `WRAITH_HASH_ONLY=1`, the same scenario produced
the same pixel hash on this branch and on `origin/main` (`ef32b2c2db84c7e0` at
DPR 1, `e82a98c3991830e5` at DPR 2, headless Chrome 155).

## Limits

- Headless only. Physical display presentation and a headed 120 Hz run were
  not measured.
- One machine and one browser. The results are relative costs on this GPU,
  not portable figures.
- Worker `performance.now()` resolution is 0.1 ms, so CPU percentiles in the
  raw JSON are quantized.
