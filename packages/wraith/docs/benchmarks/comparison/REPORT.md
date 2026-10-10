# Wraith versus xterm: dense terminal benchmark

Measured on 10 October 2026 in Chrome 155 on macOS. The OS reports an Apple M5 Max GPU; adapter details, when exposed, are retained in the raw JSON. This is one machine, with rotated test order and three runs per condition, rather than a cross-device guarantee.

The synthetic scene is **240×80 (19,200 cells)**, at a 15px JetBrains Mono font. Each update changes all rows, includes Greek letters, combining accents, line drawing and block characters, and makes approximately **4,800 SGR changes**. It sends roughly **210 KiB per full update**. Images, emoji/CJK fallback, search decorations and character joiners are excluded. Wraith's GPU mode is asserted throughout.

## Dense scene, normal resolution

Medians across three runs. Redraw CPU includes synchronous browser layout for DOM renderers. The completed pipeline includes UTF-8 input parsing, model updates, redraw and GPU completion fences every 32 updates.

| Implementation             | Redraw CPU p50 | Full pipeline updates/s | Pipeline CPU p95 |
| -------------------------- | -------------: | ----------------------: | ---------------: |
| xterm 6.0 DOM              |       18.10 ms |    50 (CPU/layout only) |         22.30 ms |
| xterm 6.0 + WebGL 0.19     |        3.60 ms |                     182 |          6.70 ms |
| Wraith compatible Terminal |        2.30 ms |                     290 |          3.80 ms |
| Wraith libghostty core     |        1.50 ms |                     371 |          2.90 ms |

The compatible Wraith path completes **1.59×** as many updates as xterm WebGL on this scene. The libghostty number measures the engine directly in Wasm; it excludes SDK/worker transport and is not a drop-in API result.

At Retina resolution (DPR 2, 4320×3200 terminal pixels), the dense-scene medians are **283 Wraith versus 180 xterm WebGL updates/s**. Wraith's medians for RGB color churn are **280 versus 193** at DPR 1 and **236 versus 178** at DPR 2. Scrolling followed by a full repaint gives **173 versus 135** at DPR 1. Native-core color churn is not universally faster than the compatible path.

## What these rates mean

These are GPU-completed drawing updates in fenced batches, **not physical display FPS**. WebGPU uses a 4-byte copy/map fence; WebGL uses fenceSync/clientWaitSync. Fence overhead is included and differs between APIs. DOM's rate counts CPU and layout completion; it does not wait for browser paint or GPU completion, so its updates/s is not an equivalent GPU measurement.

The same input bytes, font and canvas geometry are checked. Raw redraw cost is isolated using pre-parsed xterm buffer-line snapshots; the native engine parses outside that redraw timer, but its render timer includes snapshot extraction. Pipeline measurements run the actual parser and renderer together. Parser timings include synchronous core effects. All three xterm profiles retain the same xterm 6.0 semantic implementation.

A separate public-API phase serializes writes behind onRender callbacks. The headless browser's idle cadence is about 60 Hz. Wraith and WebGL usually reach that cap for dense updates; scrolling is closer to 30 callbacks/s in this one-at-a-time test. It does not certify 120 Hz presentation. Several runs have large browser/fence stalls; all runs and min/max ranges are retained rather than discarded. The benchmark is not pure GPU pass timing.

An initial forced WebGL redraw during large-atlas growth can contain incorrect texture references. The harness normally pauses automatic refresh, so it now allows a second model rebuild. **All 20 post-warmup combinations passed final-text hashes and pixel checks**, including a check for impossible debug-red pixels. The original initial captures remain identified as pre-warmup; they are not the basis of output correctness. See visual-validation.json and the *-warm.png proofs.

## Next work, based on evidence

1. **Reduce cell-packing and atlas-lookup work.** A separate CPU profile attributes about 23.3% of active sampled time to pack and 10.2% to tile. A pinned typed-buffer fast path and glyph IDs are the first compatible-renderer experiments; preserve all public API semantics and differential tests.
2. **Remove unnecessary Rust atlas key clones.** Atlas::begin constructs owned glyph keys before checking cache presence when a dirty viewport exceeds capacity. This scene crosses that threshold. Filter existing glyphs using borrowed text before cloning missing keys. This candidate is identified by code inspection; no speedup is claimed until tested.
3. **Keep decorations on WebGPU.** Search decorations, character joiners, transparency/contrast and link hover currently delegate to DOM. Supporting common decorations on GPU matters more than a headline win on a scene that avoids them.
4. **Measure realistic scrolling and tail latency.** Add append-only PTY traces, multiple terminals, atlas exhaustion, cold glyph bursts and 120 Hz physical-display tests. Use row identities to retain unchanged GPU rows. Diagnose the recorded long stalls before claiming consistent frame pacing.

**1000 updates/s is not achieved on this scene.** The compatible pipeline's CPU p95 is about 3.8 ms, already above a 1 ms budget. The 120 Hz CPU budget of 8.33 ms has headroom in this particular dense scene, but presentation, transport and tail latency still require verification.

## Reproduce

Start npm run dev, then run:

```sh
npm run benchmark:compare
WRAITH_WORKLOADS=scroll WRAITH_DPRS=1 WRAITH_APPEND=1 npm run benchmark:compare
node scripts/validate-scene.mjs
node scripts/profile-renderer.mjs
```

The default comparison tests dense/color-churn scenes at DPR 1 and 2, with three repetitions. The appended command adds three scrolling runs for each renderer at DPR 1. Set WRAITH_REPETITIONS, WRAITH_DPRS, WRAITH_WORKLOADS, WRAITH_REPORT_DIR and CHROME_PATH as needed. The interactive scene is /compare.html.

Raw measurements: [chrome.json](chrome.json). Aggregated data: [summary.csv](summary.csv), [summary.json](summary.json). Verification: [visual-validation.json](visual-validation.json). Profiling: [profile-summary.json](profile-summary.json), wraith.cpuprofile. The profile was collected separately from the benchmark.

CPU usage and device-wide GPU activity are measured separately in [UTILIZATION.md](UTILIZATION.md), with repeated fixed-rate and unpaced workloads, paired idle baselines, and raw process/counter samples. CPU-profile self-time percentages above are not CPU utilization percentages.

The benchmark uses original addons through xterm's documented [addon interface](https://xtermjs.org/docs/guides/using-addons/). Versions, Ghostty revision, Wasm/font hashes, dimensions, glyph cache sizes, every repetition and errors are recorded in chrome.json. Large screenshots and CPU traces are development evidence and excluded from the runtime npm package.
