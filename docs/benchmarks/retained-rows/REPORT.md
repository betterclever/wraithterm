# Retained GPU rows: paired speed and correctness report

Retaining physical GPU row slots improves the scrolling-log workload by **33.3%**
for the xterm-compatible renderer and **27.9%** for the libghostty renderer. Compatible
Wraith completes **5,676 updates/s**, versus **1,056** for xterm WebGL in the same batch.
Dense full-screen repaint stays approximately flat: **737 updates/s**, versus **274**
for xterm WebGL. The dense 1000-update/s target remains open.

These are warm **GPU-completed updates in fenced batches**, not physical monitor
presentations. Both profiles exceed 1000 on the dashboard, but that was also true
before this change; row retention does not establish a new dashboard speed gain.

## Results

Medians of three runs per condition, 512 pipeline frames per run:

| Workload                      | Compat before | Compat after | Change | xterm WebGL | Compat / xterm | Native after | Native change |
| ----------------------------- | ------------: | -----------: | -----: | ----------: | -------------: | -----------: | ------------: |
| Dense repaint / DPR 1         |           746 |          737 |  -1.2% |         274 |          2.69× |          627 |         +1.9% |
| RGB churn / DPR 1             |           745 |          745 |  -0.1% |         277 |          2.69× |          437 |         +2.4% |
| Eight-line log bursts / DPR 1 |         4,260 |        5,676 | +33.3% |       1,056 |          5.38× |        3,344 |        +27.9% |
| Dashboard / DPR 1             |         1,135 |        1,146 |  +1.0% |         596 |          1.92× |        1,035 |         +1.3% |
| Dense repaint / DPR 2         |           731 |          738 |  +1.0% |         284 |          2.60× |          613 |         +0.7% |

Dense/churn/dashboard median changes around ±1–2% have overlapping run ranges and
are not treated as established improvements. The log runs are separated:
compatible before **4,142–4,270**, after **5,651–5,926**; native before
**2,594–2,636**, after **3,342–3,362** updates/s. All observations, including the
DPR 2 compatible outlier at **655**, are retained in [raw runs](runs.json) and
[summary distributions](summary.json). No outliers were removed.

Compatible log redraw CPU p50 falls from **0.2 to 0.1 ms**; native falls from
**0.4 to 0.3 ms**. Browser timer granularity is approximately 0.1 ms. These are
CPU durations, not GPU utilization or render-pass timestamps.

## What changed

Visible rows map to independently owned physical cell-buffer slots. Scrolling
changes the small mapping and uploads new content; it does not re-upload every
moved row. Duplicate content cannot share a mutable slot. Contiguous logical
sources merge into one upload only when their physical destinations are also
contiguous. Disjoint damage therefore keeps clean rows off the upload path.

The identity-map shader path bypasses row indirection. Resizing, atlas resets,
selection changes and unknown/private buffer layouts retain conservative
invalidation. Legacy partial compositor uploads still address the correct slots
after rotation. Logical CPU staging and snapshot row copies remain; this change
does not claim to remove them. Both draw calls still cover the complete viewport.

The timed log pipeline records compatible cell uploads averaging **41,775 bytes**
and row mapping **317 bytes** per update; native uses **43,200 + 320 bytes**.
The full 240×80 cell buffer is **384,000 bytes**. A separate untimed
[upload probe](uploads.json) measures the before/after reduction without injecting
instrumentation into the speed runs: compatible uploads fall from **379,275 to
43,441 bytes/update (88.5% less)**; native falls from **384,000 to 43,520 (88.7% less)**.
The probe has a separate starting state from the timed pipeline. Uniform writes and surface presentation
are outside these cell/map byte counters.

## Measurement identity and limits

- Date: 2026-10-11; Apple M5 Max, 18 logical CPU cores, 48 GiB memory;
  WebGPU reports Apple / Metal 3.
- Headless Chrome 155; xterm **6.0.0**, official WebGL addon **0.19.0**.
- 240×80, 19,200 cells; 15 CSS px JetBrains Mono; identical 2160×1600
  DPR 1 canvas and 4320×3200 DPR 2 canvas.
- Dense/churn: 4,800 style changes per update. Inputs are generated before timing.
  Eight variants warm the caches; GPU completion is awaited every 32 frames and
  after the last batch. Every Wraith attempt is checked against its submission count.
- **75 rotated/interleaved runs** across five targets and five conditions;
  before/after order changes across repetitions. Initial/final visible text and
  canvas geometry agree. Text hashes remove only right-padding and trailing empty
  rows because the public native and xterm serializers differ there.
- Before: `951e53d59a8a551d5a64a6aecf367b106bd92626`.
  After: `e40f434fcc3358119a2650fece1e427f792a8ee0`; renderer implementation `9324a9e`.
- Before Wasm SHA-256: `cb823209679769fe8b8f25060401f630f596ba590124ebbe37e2242fc9d1ed20`.
  After Wasm SHA-256: `40f031244d3a09bf16c51ea7064f31ad2e33f3962889ebc6b4899dfe1ef4f552`.
  After Wasm size: **2,398,764 bytes**. Renderer source hashes are in raw metadata.

This is shared local hardware, not an isolated lab or a physical 120/1000 Hz
presentation certification. Append samples last roughly 90–150 ms; they establish
batched throughput, not hours of sustained operation. No CPU/GPU utilization
percentages were measured in this speed pass. Earlier benchmark batches and
native-only workloads remain historical and are not mixed into these ratios.

The baseline is a Git archive of the before commit with the same dependencies.
Its renderer and Wasm binary are unchanged. Correctness tests inject only an
untimed fixture helper into archived harnesses that lack it. The speed batch
ran with that helper present, outside all timed paths.

## Validation and the next bottleneck

- **44 Rust + 15 SDK tests**, including 2,000 randomized row ownership plans.
- [22 packed-word differentials](validation/renderer-differential.json) and
  [60 byte-identical incremental GPU frames](validation/incremental-pixels.json)
  across DPR 1/2 and both profiles: scrollback, margins, reverse index, duplicate
  rows, wide/combining/emoji, selection, alternate screen, atlas reset and legacy uploads.
- [19 xterm browser checks](validation/xterm-chrome.json): staging/source bounds,
  Wasm growth, sparse and cursor-only uploads, row-stamp wrap, retry/failure,
  input, upstream hooks/addons, resize and fallback.
- [Native browser checks](validation/native-chrome.json), native and xterm-alias
  installed-package consumers in Vite dev/production, strict TypeScript,
  wasm clippy, rustfmt and SDK/demo builds pass.

A separate 2048-update [CPU profile](profile/profile-summary.json) attributes
**72.1%** of active sampled time to parsing, **14.5%** to packing and **11.4%**
to other renderer work. These are sampled-time shares, not CPU utilization.
The raw profile is local and ignored. At this dense input rate, parser throughput
is the main obstacle to 1000. Further GPU work should target redundant uploads
and logical row copies; parser optimization must preserve xterm's hooks and
observable semantic contracts. Repeated full repaints have no unchanged rows to retain.

## Reproduce

Serve the saved before build on port 5190 and the current checkout on port 5173.
The before directory must contain `baseline.json` with its commit in `head`.
Then run from the current checkout:

```sh
WRAITH_BASELINE_DIR=/path/to/before npm run benchmark:retained
WRAITH_BASELINE_DIR=/path/to/before node scripts/retained-rows-uploads.mjs
npm run test:retained
```

`WRAITH_BEFORE_URL`, `WRAITH_URL`, `WRAITH_REPORT_DIR`, `CHROME_PATH`,
`WRAITH_FRAMES`, `WRAITH_REPETITIONS`, `WRAITH_WORKLOADS` and `WRAITH_DPRS`
configure the speed harness. Keep the workload, hardware and build identities
attached to any reported rate.
