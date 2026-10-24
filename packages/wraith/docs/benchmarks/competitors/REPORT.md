# Wraith, Restty and Ghostty Web — 17 October 2026

This compares Wraith's two engines separately with the exact published
`restty@0.3.0`, `ghostty-web@0.4.0`, and official xterm 6.0.0 / WebGL addon 0.19.0.
Wraith was measured with product sources from `2186929`; the benchmark harness is
committed as `47d843a`. Competitor packages are isolated from SDK dependencies,
with tarball integrity, source fingerprints and Wasm/bundle hashes preserved.
A [post-run artifact audit](artifacts.json) also verifies all 413 installed files
against the locked published tarballs, including nested Restty runtime and
transitive text-shaper modules; none differ.
The work changes benchmark infrastructure, not the shipped terminal.

Wraith's compatible profile uses xterm semantics with its accelerated input path
and Rust/Wasm/WebGPU renderer. Its native profile uses libghostty and the native
Wraith renderer. [Restty](https://github.com/wiedymi/restty) combines libghostty-vt,
WebGPU/WebGL2 and TypeScript text shaping; [Ghostty Web](https://github.com/coder/ghostty-web)
uses a Ghostty Wasm core with a Canvas2D browser renderer in this pinned release.
Those are different host/rendering implementations around related terminal cores.

## Measurement and scope

Apple M5 Max, 18 logical CPUs, 48 GiB, headless Chrome 155, Apple Metal 3. The
machine was shared with active applications and background CPU work. The batch
records system load before/after each run (one-minute load ranged 4.65–39.64
on 18 logical CPUs); absolute rates
are observations under that load, not quiet-machine peaks. Do not compare them
directly with the earlier performance-pass rates as if the difference were a
Wraith regression or improvement.

Five implementations × seven conditions × three rotated repetitions. Each run
uses 64 warmup updates and 256 measured updates, cycling the same eight input
variants. Every implementation receives identical UTF-8 bytes. The grid is
240×80, JetBrains Mono Regular at 15 CSS pixels, with actual backing canvases of
2160×1600 at DPR1 and 4320×3200 at DPR2. Generation, initialization, screenshots
and correctness reads are outside timing. A coordinated three-minute pause after
the complete logs condition stopped every owned benchmark/browser process while
an independent agent ran its own tests. No measured update crossed that boundary;
the [control record](matrix/control.json) preserves it. SDK sources remained
pinned; later optimization work is not part of this comparison.

Wraith native/compatible and Restty count actual GPU submissions. The xterm
control verifies every renderer invocation issues GPU draw commands. GPU queue
completion is fenced every 32 updates and at the end. These are controlled
engine-pipeline updates per second, **not physical display FPS**, public write
callback throughput or worker/PTY round-trip latency. Rendering is manually
stepped so no input update is silently coalesced into a later GPU update.

Ghostty Web's Canvas2D result is separately labeled: draw calls plus a one-pixel
readback every 32 updates and at the end. Canvas2D exposes no equivalent GPU
fence and intermediate paints can coalesce. Its number must not be called
GPU-completed frames/s or turned into a physical-FPS multiplier. Synchronous
parse/render call durations are the more direct comparison with that implementation.
They are CPU-side wall times, including scheduling delays, not sampled CPU time
or utilization. A sub-tick P50 can round to zero on small log updates.

Explicit common-feature settings matter:

- Scrollback is disabled for every engine because their limit units differ.
  Logs measure viewport scrolling, not retained-history costs.
- Restty uses `fontSizeMode: em`, ligatures off and native alpha blending to
  match the common rendering budget. Its UTF-8-to-string conversion is timed
  because the published runtime accepts strings. This is a normalized-options
  test, not a default-configuration or full-feature comparison.
- Ghostty Web measures a 9×16 CSS-pixel default cell with this font. Only its
  line-box height is changed to 20, keeping its font size and baseline, so it
  draws the same viewport area as the other engines.
- Input hashes, initial/final grapheme-aware text and **actual canvas sizes**
  are checked. Different rasterizers are not expected to produce identical glyph
  antialiasing. Text equality alone does not establish feature or pixel parity.

The repository's `scripts/competitors/README.md` details all adapters and
environment variables. No upstream source is modified and no real shell or PTY
service is started. Reproduce the exact matrix from the repository root:

```sh
node scripts/competitors/prepare.mjs --install
node scripts/competitors/audit.mjs
node scripts/competitors/validate.mjs
WRAITH_WORKLOADS=complex,churn,append,showcase,pipes,dense-no-combining WRAITH_REPORT_DIR=.cache/competitor-matrix node scripts/competitors/run.mjs
```

## Throughput

All 105 timed executions completed without browser failures or source-fingerprint changes. All 84 GPU-path executions match initial/final text and real canvas dimensions. Nine Ghostty Web executions differ in text, producing 27 separate initial/final/public-buffer mismatch records; there are no geometry mismatches.

Medians of three repetitions, with their full minimum–maximum range in parentheses. These ranges are observations, not confidence intervals. GPU-completed engine updates/s:

| Workload            | DPR |   Wraith compatible |       Wraith native | Restty WebGPU |   xterm WebGL |
| ------------------- | --: | ------------------: | ------------------: | ------------: | ------------: |
| Dense               |   1 |       495 (448–506) |       351 (323–376) |    68 (67–69) | 114 (107–130) |
| RGB churn           |   1 |       472 (467–552) |       231 (226–252) |    50 (49–58) |   97 (87–110) |
| Logs                |   1 | 3,743 (3,570–3,908) | 1,840 (1,803–1,850) | 152 (149–154) | 600 (596–624) |
| Dashboard           |   1 |   1,459 (799–1,464) |   1,002 (556–1,004) | 183 (107–186) | 576 (563–603) |
| Pipes               |   1 |       456 (448–461) |       248 (244–250) | 127 (126–131) | 242 (237–252) |
| Dense, no combining |   1 |       918 (910–919) |       650 (647–651) | 111 (110–112) | 265 (256–271) |
| Dense               |   2 |       861 (854–885) |       594 (592–611) | 108 (104–108) | 243 (228–245) |

The shared-machine load changed materially between conditions. In particular, the later DPR2 and no-combining runs occurred after load eased; their higher rates relative to the original DPR1 dense run do **not** establish a Retina or Unicode-removal speedup. The dashboard range also shows within-condition drift. Do not pool these conditions into one product speed score.

Ghostty Web uses a different completion measure: Canvas2D draw-call updates plus periodic readback. The following table is **not GPU-completed FPS**. Times are medians of each run’s per-update P50 synchronous call durations:

| Workload            | DPR | Canvas calls/s (range) | Parse ms | Draw ms | Core text agrees           |
| ------------------- | --: | ---------------------: | -------: | ------: | -------------------------- |
| Dense               |   1 |       15.8 (15.7–15.9) |      3.3 |    67.1 | No: right-margin combining |
| RGB churn           |   1 |          7.0 (6.8–7.2) |      4.1 |   163.9 | No: right-margin combining |
| Logs                |   1 |       21.0 (20.7–21.0) |      0.0 |    39.4 | Yes                        |
| Dashboard           |   1 |       32.4 (19.1–32.9) |      0.9 |    25.9 | Yes                        |
| Pipes               |   1 |       25.8 (25.8–25.9) |      5.0 |    37.5 | Yes                        |
| Dense, no combining |   1 |       25.7 (25.7–25.8) |      1.6 |    41.5 | Yes                        |
| Dense               |   2 |       11.4 (11.2–11.5) |      2.2 |   111.3 | No: right-margin combining |

For the original dense DPR1 scene, synchronous parse/render wall times make the main-thread cost visible without treating Canvas2D readback as a GPU fence:

| Implementation                      | Parse ms | Render ms |
| ----------------------------------- | -------: | --------: |
| Wraith compatible                   |      1.3 |       0.6 |
| Wraith native                       |      1.9 |       0.9 |
| Restty WebGPU                       |      2.4 |      12.0 |
| Ghostty Web Canvas2D (text differs) |      3.3 |      67.1 |
| xterm WebGL                         |      1.5 |       6.8 |

[Raw runs](matrix/runs.json), [summary](matrix/summary.json) and [CSV](matrix/summary.csv) retain every repetition, completion method, source/input hashes, stage quantiles and mismatch. The source pin is the pre-existing product build, not the subsequent parser experiment.

## Correctness and rendering observations

The [validation record](validation/results.json) contains 120 target/DPR case
executions: 110 focused fixture executions and 10 dense core-versus-public-buffer
snapshots. Cases include combining marks, right margins, wide-cell overwrite, an emoji sequence,
SGR between grapheme codepoints, alternate screens, saved cursors, scroll regions,
hyperlink text, nine truecolor backgrounds and five underline styles. This is a
targeted comparison, not an exhaustive terminal-conformance certification.

Both Wraith profiles and Restty agree with the official xterm text output on all
these fixtures and reproduce every sampled background color. Both Wraith
profiles and Restty produce five distinct underline patterns at both DPRs.
Official xterm produces four distinct raster rows at DPR1 and five at DPR2; this
small-resolution raster distinction is recorded without asserting a parser bug.

The pinned Ghostty Web release has reproducible differences:

1. At columns 239–240, `éä` becomes `é̈a`: the final diaeresis joins the previous
   cell. This also affects the original dense and RGB-churn workloads. Their
   rates are flagged as output-mismatched, not equivalent-quality wins/losses.
   A separate `dense-no-combining` case removes combining marks from the input
   for **every** implementation; the original results remain in the batch.
2. Its public `buffer.active.getLine(...).translateToString()` omits combining
   marks even when the renderer's core data retains them. The harness records
   that API mismatch and uses grapheme-aware core data to assess rendered text.
3. Explicit truecolor black backgrounds render as the configured default
   background (`#101824`) in the sampled cell. The other eight sampled colors
   agree. Both DPRs reproduce it.
4. All five requested underline styles render as the same single underline in
   the captured rows. This limits feature parity even in the no-combining case.

These observations apply to the pinned web wrapper and artifacts, not to all
versions of Ghostty or libghostty. Differences are retained in the raw data and
are not repaired or hidden by the benchmark.

## Retina control correction

The initial screenshot checks exposed a harness issue in the official WebGL
control. Chrome's emulated DPR2 disagreed with the resize observer's physical
pixel box. xterm's internal `dimensions` still said 4320×3200 while its actual
WebGL canvas had been resized to 2160×1600, invalidating a metadata-only geometry
check. The new harness suspends the renderer's own resize observer and reapplies
its grid resize, then checks real canvas dimensions. Untimed pixel checks pass
after this correction; timing retains the ordinary non-preserved WebGL buffer.

This finding further limits earlier metadata-only Retina comparisons with xterm,
as [corrected in the earlier report](../gold-standard/REPORT.md#full-browser-matrix-and-regression-follow-up).
It does not itself invalidate Wraith-only paired DPR2 tests; their separate
noise caveats remain. It is not evidence that normal xterm use on a physical
Retina display has this bug.
The correction changes benchmark geometry/scheduling, not renderer algorithms.

## What this does not establish

No startup, bundle-transfer, process CPU%, GPU utilization%, battery, input/IME
latency, screen-reader behavior, long scrollback, Kitty graphics, ligature shaping,
multi-pane interaction, worker transport or non-WebGPU fallback benchmark ran.
Restty's broader built-in UI/features and WebGL2 fallback are not represented by
the normalized fast-path workload. Wraith's native core has not been accelerated
by this comparison. Cross-device stability and a quiet dedicated-machine repeat
remain necessary before making universal marketing claims.

## Where Wraith leads, and what remains open

The compatible profile has the highest observed median GPU-completed throughput in all seven conditions. Its per-condition median ratios are 1.88–6.24× xterm WebGL and 3.59–24.54× Restty in this normalized, shared-machine matrix. These are conditional observations; the wide dashboard range and three repetitions do not establish universal multipliers.

The native profile also leads Restty in these conditions, but it has **no clear overall win over xterm on Pipes**: native ranges from 244–250 updates/s and xterm from 237–252. Native’s parse-call P50 is about 3.3 ms against xterm’s 2.3 ms; its faster render call (0.5 ms against 1.4 ms) offsets that deficit. This is a useful loss at a specific stage, and a reason to profile native input/state exchange before choosing the next optimization. The compatible profile remains faster than native here; sharing libghostty ancestry does not imply equal browser integration costs.

Ghostty Web’s synchronous draw work is much larger on these fixtures, and the targeted rendering/API differences matter independently of speed. Its Canvas2D completion semantics and incomplete style parity prevent an honest “times faster GPU FPS” claim against it. Restty passes the tested common-subset output and offers broader UI/shaping/fallback capabilities that this narrow benchmark does not score. No broad compatibility winner is established.

A stable 1,000 completed dense updates/s result is still unproven. Keep the compatible parser and native input/state-exchange costs as separate optimization targets, and repeat the same controlled matrix on a quiet machine and additional GPUs before promoting these numbers as general product claims.
