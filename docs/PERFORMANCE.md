# Performance

**Current results:** the [efficiency pass](benchmarks/efficiency/REPORT.md)
measures both profiles against `a136240` with interleaved runs. Dense
240×80 updates are 23–60% faster, and log streaming is about 95% faster.
Redraw CPU drops to 0.3 ms (compat) and 0.5 ms (native). Every scene is
pixel-identical to the earlier build. Sections below are earlier
measurements, retained with their original builds.

These measurements cover the **libghostty `Wraith.mount()` worker profile**.
The xterm-compatible `Terminal` profile uses a different semantic core and
browser rasterizer; these throughput figures do not measure that profile.

The recorded Chrome suite verifies actual terminal pixels before measuring throughput.
It ran with default Chrome WebGPU settings on macOS, devicePixelRatio 1, a 13 CSS
pixel font, and line height 1.45. Chrome identified the backend as BrowserWebGpu;
it did not expose a hardware model, so no specific GPU model is claimed.

## Head-to-head comparison

The newer [dense-scene comparison](benchmarks/comparison/REPORT.md) measures the
compatible Terminal against xterm 6.0 DOM and WebGL, alongside the libghostty
engine. It records 60 runs at 240×80 with 4,800 style changes per frame, plus
post-warmup pixel/text validation. On the dense DPR 1 scene, compatible Wraith
completes about 290 GPU-fenced updates/s versus 182 for xterm WebGL. This workload
has substantially more input and styling than the earlier benchmark below.

The earlier results below retain their original binary SHA and date; the
comparison uses an instrumented build with a compositor fence export. Neither
set is a claim about physical display refresh.

[CPU and GPU utilization](benchmarks/comparison/UTILIZATION.md) is sampled
separately during repeated continuous runs. CPU covers the benchmark's dedicated
Chrome instance. GPU counters cover the entire device and include paired idle
baselines; they cannot be attributed to one library on this shared machine.

The [newer optimization pass](benchmarks/optimization/REPORT.md) compares a saved
pre-change build with the final optimized build in alternating order. Its source
and binary hashes, submitted-frame checks and differential results are recorded
separately. Earlier speed and usage figures below remain historical measurements.

The subsequent [bulk packing and persistent staging pass](benchmarks/packing/REPORT.md)
records 48 alternating runs and independent staging experiments. The compatible
pipeline improves by about 7–11% across the tested conditions; staging's separate
throughput effect remains noisy. It also verifies actual submitted cells after
forced Wasm memory growth. All new records carry their source/binary identities.

## Recorded results

| Grid   | Workload          | Frames | GPU-fenced frames/s | CPU p50 ms | CPU p95 ms | CPU p99 ms |
| ------ | ----------------- | -----: | ------------------: | ---------: | ---------: | ---------: |
| 80×24  | sparse            |    512 |              11,532 |       0.00 |       0.10 |       0.20 |
| 80×24  | dense             |    512 |               8,166 |       0.10 |       0.20 |       0.20 |
| 80×24  | scroll            |    512 |               8,298 |       0.10 |       0.20 |       0.20 |
| 160×50 | sparse            |    512 |               7,829 |       0.00 |       0.10 |       0.20 |
| 160×50 | dense             |    512 |               2,238 |       0.40 |       0.50 |       0.60 |
| 160×50 | scroll            |    512 |               2,353 |       0.40 |       0.50 |       0.60 |
| 160×50 | dense (sustained) |  8,192 |               2,280 |       0.40 |       0.50 |       0.60 |

The sustained dense run completed **8,192 frames in 3.59 seconds**, averaging
**2,280 GPU-completed frames/s**. Its CPU p95 was **0.50 ms**.

[Latest native browser verification](benchmarks/chrome.json) includes the exact Wasm SHA-256,
Ghostty revision, user agent, all timings, and the pixel assertion summary.
[An earlier unoptimized run](benchmarks/baseline-chrome.json) is retained for
context. Runs are observations on this machine, not a controlled A/B comparison.

## What the benchmark measures

Inputs are generated before the timed region. Sixty-four warmup frames populate
the glyph atlas and exercise the parser. Each measured iteration writes a fresh
payload, captures the terminal snapshot, updates dirty rows, encodes a render
pass, and submits it. Every 32 submissions, a four-byte GPU buffer copy is mapped
and awaited; a final fence waits for the last batch. The elapsed time therefore
includes GPU completion waits rather than counting an unchecked submission loop.

The dense payload changes every cell, its character cycle, and row colors. Sparse
updates one row; scroll appends a line and shifts the viewport. The same 64-frame
payload cycle makes the input deterministic. Large-grid rendering covers a full
1280×950 pixel canvas even when the page's host clips the visible viewport.

CPU percentiles include parsing, snapshot traversal, atlas lookup, uploads,
encoding, and submission. They exclude the main-thread SDK and worker message
transport, and do not isolate GPU execution time. Cold rasterization and pipeline
initialization are excluded by warmup. Browser timer resolution is about 0.1 ms
in this test; zero samples mean below timer resolution.

**These are completed render frames in fenced batches, not distinct monitor
presentations.** Browsers present through refresh-paced requestAnimationFrame.
A 120 Hz screen has an 8.33 ms presentation budget; 1000 Hz would have a 1 ms
budget. The measured warm pipeline has headroom for the target, but 120 Hz physical
presentation still requires an appropriate browser, display, workload, and input
feed. This suite does not certify a particular monitor refresh rate.

## Distribution size

The optimized Wasm module is **2.27 MiB raw / 797 KiB gzip**.
wasm-opt version 133 with -O3 --strip-dwarf reduced it from
2,931,003 to 2,380,758 bytes. Font data is a separate
270 KB asset for the libghostty profile. The xterm profile rasterizes CSS fonts
without a font download. Its pinned xterm core is the one npm runtime dependency.

## Repeat

Run the demo server, then:

```sh
npm run test:browser
```

The suite records six 512-frame runs, an 8192-frame sustained dense run, and PNG
proof under docs/benchmarks. Set WRAITH_REPORT_DIR to retain another run separately.
Use the playground to select a workload and export its raw JSON result. Test
physical refresh behavior separately on the intended 120/144/240 Hz displays.

## Next performance work

Measure cold Unicode glyph storms, atlas rebuilding, multiple simultaneous
terminals, large PTY output bursts, and background-to-foreground transitions.
Optional GPU timestamp queries can separate GPU pass time from CPU time and
queue/fence overhead. A row-identity mapping could reduce scroll uploads. These
should each be backed by a recorded before/after workload.
