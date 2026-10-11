# SGR action optimization: measured gains with xterm compatibility

Common color/style actions now avoid temporary normalization arrays and commit
validated attributes once. The compatible dense pipeline improves **14.5%**,
from **676 to 774 GPU-completed updates/s**, and the dashboard improves **17.8%**,
from **1,002 to 1,180**. The dense **1000-update/s target remains open**.

A separate **4,096-update dense batch** confirms the direction: **677 →
767 updates/s (+13.3%)**. These are completed updates in fenced batches,
not distinct display presentations or a physical 120/1000 Hz certification.

## Paired results

Medians of three runs per target/condition; 512 timed pipeline updates per run.
All 75 runs and outliers are preserved in [raw measurements](runs.json),
[summary distributions](summary.json) and [CSV](summary.csv).

| Workload                      | Compatible before | Compatible after | Change | xterm WebGL | Compat / xterm | Native after | Native change |
| ----------------------------- | ----------------: | ---------------: | -----: | ----------: | -------------: | -----------: | ------------: |
| Dense repaint / DPR 1         |               676 |              774 | +14.5% |         203 |          3.81× |          593 |         +0.0% |
| RGB churn / DPR 1             |               663 |              748 | +12.8% |         198 |          3.77× |          403 |         -0.8% |
| Eight-line log bursts / DPR 1 |             4,596 |            5,064 | +10.2% |       1,040 |          4.87× |        2,951 |         -3.1% |
| Dashboard / DPR 1             |             1,002 |            1,180 | +17.8% |         575 |          2.05× |          864 |         -5.5% |
| Dense repaint / DPR 2         |               630 |              689 |  +9.4% |         175 |          3.95× |          549 |         -2.9% |

Compatible run ranges:

| Workload                      | Before range | After range |
| ----------------------------- | -----------: | ----------: |
| Dense repaint / DPR 1         |      654–700 |     752–798 |
| RGB churn / DPR 1             |      622–668 |     747–764 |
| Eight-line log bursts / DPR 1 |  4,580–5,010 | 5,025–5,089 |
| Dashboard / DPR 1             |    964–1,052 | 1,144–1,235 |
| Dense repaint / DPR 2         |      600–632 |     672–731 |

The dense, churn, dashboard and Retina ranges are separated in this batch.
Log samples last around 100 ms and their closest before/after observations nearly
meet; treat the log percentage as an observation with substantial scheduling/GPU
uncertainty, not an established parser-only gain of that magnitude.

The libghostty engine and GPU renderer are unchanged, with identical Wasm and
renderer-source hashes. Native results act as a noise control, not a claimed
native optimization. Their median changes range from approximately 0% to −5.5%.
Unrelated browser, window-server and container activity remained running on this
shared machine. Only within-batch comparisons are used; absolute rates from the
older retained-row report are not a baseline for this pass.

## Longer dense batch

The separate [long batch](long-batch/runs.json) runs 4,096 updates for each of five
targets, retaining all submissions and GPU fences. Results:

| Target               | Completed updates/s |
| -------------------- | ------------------: |
| Compatible before    |                 677 |
| Compatible after     |                 767 |
| Official xterm WebGL |                 174 |
| Native before        |                 587 |
| Native after         |                 591 |

The compatible after pipeline takes about 5.34 seconds. This checks a longer
batch, not hours of sustained use. One run per target provides no confidence
interval. Its results are not pooled with the three-repetition main batch.

## What changed

`xterm-input.ts` adds two instance-local actions behind guards for the pinned
xterm 6.0 runtime:

- Complete semicolon RGB and 256-color foreground/background values are packed
  directly, preserving flags and upstream 8-bit channel masking. No temporary
  color-normalization arrays are created on that path.
- Supported style/color combinations calculate into local words and update the
  attributes only after the entire sequence is accepted. An unsupported or colon
  parameter falls back before changing state. Upstream still resets/clones
  extended attributes and retains hyperlink state.

Every input byte still goes through xterm's decoder and parser. All CSI handler
ordering, synchronous/async interception, continuation and write callbacks remain
upstream-controlled. Malformed/incomplete/mixed colors, underline colors and other
unsupported combinations use the original actions. There is no input-pattern
cache, frame cache, dropped sequence, native ANSI replay or upstream prototype
mutation. The GPU packing/upload/draw path is unchanged.

The extra private input boundary must be revalidated before changing the pinned
xterm dependency. An experimental numeric-parameter specialization was evaluated
and omitted because it did not establish a reliable additional gain.

## CPU evidence and remaining ceiling

The normal benchmark measures input parsing separately from rendering. Medians
of each run's 64-sample mean, in milliseconds per update:

| Workload                      | Parse before | Parse after | Change |
| ----------------------------- | -----------: | ----------: | -----: |
| Dense repaint / DPR 1         |        1.081 |       0.900 | -16.8% |
| RGB churn / DPR 1             |        1.116 |       0.889 | -20.3% |
| Eight-line log bursts / DPR 1 |        0.056 |       0.050 | -11.1% |
| Dashboard / DPR 1             |        0.720 |       0.527 | -26.9% |

These isolated parse timers are separate from the pipeline timing. Dense pipeline
CPU p95 improves from **1.8 to 1.4 ms**; dense renderer p50 remains **0.3 ms**.
Timer granularity is approximately 0.1 ms, so sub-millisecond distributions and
especially log parsing should not be overinterpreted.

Separate 2,048-update [before](profile-before/profile-summary.json) and
[after](profile-after/profile-summary.json) V8 profiles use 500 µs sampling.
Color extraction is no longer a major isolated hotspot. The after profile still
attributes about **74% of active sampled time to parsing**, **16% to packing**
and **9% to other renderer work**. The generic parser loop, printing and UTF-8
decoding remain the next CPU targets. These are sampled work shares, **not CPU
utilization or GPU utilization percentages**. Profiles are outside the speed runs.

The new median dense pipeline is about **1.29 ms/update**. Reaching 1000 here
requires roughly **0.29 ms less total time** under comparable conditions. The next
optimization targets are the parser and cell packing; the independent GPU ceiling
has still not been measured. This pass does not transfer its xterm-profile gains
to the native Ghostty parser.

## Identity and method

- Date: 2026-10-11T06:58:07.795Z; Apple M5 Max, 18 logical CPUs, 48 GiB; Apple/Metal 3 adapter.
- Headless Chrome 155; xterm 6.0.0 and official WebGL addon 0.19.0.
- Grid 240×80, 19,200 cells; JetBrains Mono 15 CSS px; DPR 1 is 2160×1600,
  DPR 2 is 4320×3200. Dense input contains 4,800 SGR changes/update.
- Before: `574b206d6c91c4661c13263060cbe7083ac0662e`.
- After measured source: `08c117f6c17daae74b89374a701071191a9f25d5`;
  runtime implementation commit `0507849`.
- Both Wasm SHA-256: `40f031244d3a09bf16c51ea7064f31ad2e33f3962889ebc6b4899dfe1ef4f552`.
- Input adapter SHA-256: `743ed5ff15ad33740e0141e0ec4c75f30bef270f4894aade94570beae1f9c3c3`.
- Every SDK source hash is recorded and rechecked after the batch. Baseline is
  an archive of the before commit with the same installed dependencies.
- Eight input variants are generated before timing and warmed for 32 updates.
  GPU completion is fenced every 32 frames and after the last batch. Each Wraith
  pipeline checks its actual submission count against the requested count.
- Targets rotate across repetitions. Initial/final visible text and canvas
  geometry match. Text comparison normalizes only trailing ASCII whitespace
  and empty trailing rows because the native text API omits viewport padding.
- No CPU/GPU utilization sampling runs concurrently with speed measurements.
  Public API pacing remains recorded separately and does not establish physical
  display FPS. No measurements were discarded from the recorded batches.

## Validation

- **21 SDK tests**, including 6,000 seeded random SGR sequences, 2,400 common
  combinations, incomplete/mixed/overflow colors, every-byte fragmentation,
  hyperlink/extended-state preservation, atomic fallback and async SGR hooks.
- **20 Chrome compatibility checks**, including actual GPU pixels, original
  addons, async interception, memory growth, retained rows and fallback/recovery.
- **60 incremental frames with byte-identical pixels/text**, across both profiles
  and DPR 1/2, compared with the preserved build.
- **22 packed-word/text/state differential fixtures**.
- Strict TypeScript, SDK/demo builds, native installed-package and unchanged
  `@xterm/xterm` alias consumers in both Vite dev and production.

Machine-readable browser and differential records are in [validation](validation/xterm-chrome.json).
No Rust implementation or Wasm artifact changed; engine compilation/native Rust
unit tests were not rerun for this JavaScript input-only change.

## Repeat

Run the current demo on localhost:5173 and an archive of `574b206` on localhost:5190.
The archive needs the same dependencies and a `baseline.json` containing its full
commit as the `head` field. Then:

```sh
WRAITH_BASELINE_DIR=/absolute/path/to/baseline \
WRAITH_REPORT_DIR=docs/benchmarks/sgr-actions npm run benchmark:retained

WRAITH_BASELINE_DIR=/absolute/path/to/baseline \
WRAITH_REPORT_DIR=docs/benchmarks/sgr-actions/long-batch \
WRAITH_REPETITIONS=1 WRAITH_FRAMES=4096 WRAITH_WORKLOADS=complex WRAITH_DPRS=1 \
npm run benchmark:retained

WRAITH_REPORT_DIR=docs/benchmarks/sgr-actions/profile-after \
WRAITH_PROFILE_ITERATIONS=2048 node scripts/profile-renderer.mjs
```

For a baseline profile also set `WRAITH_SOURCE_DIR` to the archive and
`WRAITH_URL` to its `/compare.html?type=wraith` URL. Do not edit the SDK during
measurement; source changes invalidate the paired batch. Full CPU profiles and
PNG captures remain local, while summaries and raw timing JSON are committed.
