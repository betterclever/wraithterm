# Kitty graphics streaming

Apple M5 Max, Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36, WebGPU at DPR 1. Runner and build `165324c`; Wasm, worker and runner hashes are in [results.json](results.json), with every per-frame sample.

A native 160×45 terminal receives full-grid animated frames, scaled to every cell (`c=160,r=45`). Each frame is a fresh transmit-and-display (`a=T`) under one image ID, base64-chunked at 4,096 bytes as real clients send it, and every pixel changes between frames. A frame's time is `write()` plus `flush()`; `flush()` resolves after that frame's render and its GPU fence, so frames are measured one at a time with no pipelining. 24 distinct frames are generated and encoded in the page before timing. Each workload is warmed for 30 frames, then 180 frames are measured. Three rounds alternate workload order, with a fresh page per run. Nothing else ran during measurement.

| Workload      | Payload per frame | GPU-completed frames/s (3 runs) | Payload MiB/s | p50 ms | worst p95 ms |
| ------------- | ----------------: | ------------------------------: | ------------: | -----: | -----------: |
| RGBA 640×360  |          1.17 MiB |                         669–699 |       786–821 |   1.40 |         2.30 |
| RGBA 1280×720 |          4.70 MiB |                         234–238 |     1101–1117 |   4.20 |         4.70 |
| PNG 640×360   |          0.45 MiB |                         194–197 |         88–89 |   5.00 |         6.00 |
| PNG 1280×720  |          1.82 MiB |                           57–60 |       104–109 |  17.00 |        18.20 |

By design, raw RGBA retransmissions of the same size upload into the image's existing texture rather than allocating a new one; this run does not count uploads separately. At 1280×720 that is about 3.5 MiB of pixels per frame, decoded from about 4.7 MiB of escape-encoded payload. PNG frames are smaller to transmit but cost a Wuffs decode in Wasm, which dominates at 1280×720: 640×360 PNG is about 3.3× faster for 4× fewer pixels. This is decode-bound, not display-paced.

## Limits

These are GPU-completed frames per second for a synthetic stream on one machine, not physical display frames. Pipelined clients that do not wait for each frame can exceed them; display presentation is capped by the screen. xterm.js 6.0 has no Kitty graphics, so there is no like-for-like baseline. Unicode-placeholder placements and timed animation playback are not measured, because they are not supported yet.

Reproduce with the demo server running: `WRAITH_URL=http://127.0.0.1:5173/playground.html node scripts/kitty-benchmark.mjs`.
