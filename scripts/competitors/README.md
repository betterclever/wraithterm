# Pinned browser-terminal comparison

This harness compares Wraith's compatible and native engines separately with
official xterm WebGL, `ghostty-web` 0.4.0 and `restty` 0.3.0. Competitors are
installed under `.cache/competitor-packages`; they are not SDK dependencies.
Their exact tarball integrity and transitive versions are locked here. No PTY
server, shell session, network terminal or product source patch is involved.

From the repository root:

```sh
node scripts/competitors/prepare.mjs --install
node scripts/competitors/validate.mjs
node scripts/competitors/run.mjs --probe
WRAITH_REPORT_DIR=.cache/competitor-matrix node scripts/competitors/run.mjs
```

The scripts start and close their own static Vite server on loopback port 5196
and isolated headless Chrome. They use a separate Vite cache so another worktree
cannot invalidate their optimized dependencies. Close other demanding apps and
run no simultaneous build, browser benchmark or profiler. Source fingerprints
must remain unchanged for a complete batch.

Optional variables: `WRAITH_TARGETS=wraith,ghostty,restty,ghostty-web,webgl`,
`WRAITH_WORKLOADS=complex,churn,append,showcase,pipes,dense-no-combining`,
`WRAITH_FRAMES=256`, `WRAITH_WARMUP=64`, `WRAITH_REPETITIONS=3`,
`WRAITH_RETINA=0`, `WRAITH_REPORT_DIR`, `CHROME_PATH`.

## What is measured

Each input update is parsed and an existing renderer is invoked exactly once.
Wraith and xterm use the same internal synchronous adapters as the existing
comparison demo. Restty uses its original scheduled render callback, captured
and stepped by the harness; its renderer source and algorithms are unmodified.
Its published runtime session provides the device for queue completion and
submission counting. Ghostty Web uses its original Canvas2D renderer with the
automatic animation loop suspended. All glyph caches warm across eight variants.

WebGPU and WebGL completion is fenced every 32 updates and at the end. Restty and
Wraith count actual GPU submissions; xterm counts renderer calls and verifies
each issues GPU draw commands. These are controlled engine-pipeline capacities, not
public write callback rates or physical display FPS.

Canvas2D exposes no equivalent GPU fence. Its result is draw-call throughput
with a one-pixel readback every 32 updates and at the end. Intermediate canvas
paints may coalesce; it must not be called GPU-completed frame throughput or used
to claim a display-FPS multiplier. Per-update synchronous CPU parse/render costs
are recorded for every target, alongside the distinct completion semantics.

## Fairness and deliberate limits

- Same UTF-8 bytes, eight workload variants, grid, primary font, 15px size and
  canvas backing area. Input generation is excluded from timing.
- The WebGL control's own resize observer is suspended and its grid resize is
  reapplied. In headless Chrome, emulated DPR can disagree with the observer's
  physical pixel box; validating metadata alone would miss a smaller real
  canvas. The harness checks actual canvas width/height. Untimed screenshot
  fixtures additionally preserve the WebGL drawing buffer; timing does not.
- Restty accepts strings, so decoding the common UTF-8 bytes is timed. Its
  `fontSizeMode: em` matches the other engines' font-size interpretation;
  ligatures and linear blending are disabled to use their common feature set.
  This is an explicitly normalized configuration, not a default-options test.
- Ghostty Web's default measured line box is shorter. The harness overrides
  only its cell height to 20 CSS pixels while keeping its font size and baseline,
  matching the other renderers' grid and fill area. Original metrics are recorded.
- Scrollback is zero for every target because competitors express its limit in
  different units. The append case measures viewport scrolling, not retained
  history costs. User input, workers and PTY transport are outside this test.
- Text hashes, input hashes and actual geometry are validated. Differences are
  retained and flagged, never silently normalized away. Padding normalization
  removes trailing ASCII spaces/tabs and empty rows only.
- Ghostty Web's public buffer text API omits combining marks. A separate
  grapheme-aware core snapshot checks rendered content, while the public API
  mismatch remains a documented result. The original complex scene is retained
  even if its right-margin grapheme output differs. `dense-no-combining` is a
  separately labeled common-subset input, not a repair to a competitor.
- Rasterizers differ. Text equality does not establish pixel or feature parity.
  Untimed fixtures sample truecolor background pixels and preserve underline
  style screenshots and text/width differences.
- The browser imports all adapter modules before each timed run. Loading and
  startup latency are therefore deliberately not measured.

Raw output contains all repetitions and ranges. Do not pool different batches,
mask correctness failures with aggregate averages or infer other machines'
performance from these results. Runtime JS and Wasm are the pinned published
competitor artifacts; no upstream repository instructions are executed.
