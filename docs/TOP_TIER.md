# Wraith: engineering plan for a top-tier terminal

Wraith should win on responsive input, reliable 120 Hz presentation, correct terminal behavior, low resource use, and effortless integration. A 1000-update/s stress result remains a useful stretch target. It is one workload-specific throughput measurement, not the complete product standard.

This plan separates implemented changes from proposed work. Its priorities come from the current source, the dense-scene CPU profile, compatibility checks, and before/after measurements. Performance targets below are proposed acceptance criteria, not claims that Wraith already meets them on every device.

## Architecture decisions

Keep two explicit profiles. The compatible `Terminal` preserves xterm's semantic core, callbacks, parser hooks, live buffers and addons. The native `Wraith.mount()` profile keeps libghostty, shaping and GPU rendering together in a worker. Do not parse output twice, replay terminal state through ANSI, or silently assign the native engine's speed to the compatible API. Replacing xterm's semantic core with Ghostty requires a separate conformance project; moving synchronous API state into a worker is not a free optimization.

The renderer should consume stable row identities, revisions, glyph IDs and packed attributes. Presentation scheduling should consume damage and deadlines. Neither layer should own terminal semantics. Preserve ordered input and resize effects; coalesce redundant presentation work rather than dropping terminal bytes or callbacks.

## Work implemented in this pass

- Native atlas preflight borrows glyph strings, checks hits before creating missing-key entries, and excludes spaces that require no tile. A full warm viewport no longer clones thousands of glyph strings merely to check capacity.
- Compatibility packing reuses cell and uniform buffers and a float view. It overwrites blank/continuation glyph coordinates explicitly instead of clearing the complete staging array before writing every populated record.
- Adjacent cells reuse decoded ordinary attributes. This cache holds one style, resets per pack, and bypasses extended attributes. RGB churn cannot grow it, and selected colors remain resolved per cell.
- Unicode scalar glyphs have a numeric cache referencing the existing tile variants. Warm scalar cells avoid reconstructing Unicode strings. Combining clusters use the original string path, and both caches reset together.
- A temporarily unavailable surface retains pending presentation. Native damage is acknowledged only after submission; the worker retries without waiting for another write. The compatible renderer also requests a retry. An added browser regression simulates a skipped presentation.
- Benchmark pipelines check actual WebGPU submission counters rather than assuming every attempted update submitted a frame. Packed-output differential fixtures compare every word at DPR 1 and 2.
- The subsequent row-packing pass reads guarded three-word xterm rows directly for ordinary scalar cells and retains getter fallbacks. The compositor owns persistent Wasm cell and uniform staging, removing binding allocations and copies from normal compatible redraws. Cold glyph uploads that grow memory refresh views and repack the affected row. Bounds, reserved uniform reset, and actual submitted cells after forced growth are tested.

- The efficiency pass packs 20-byte cells with one glyph word and sizes glyph quads to ink. It replaces string hashing with a scalar glyph table and cuts per-cell libghostty queries. Both profiles reuse unchanged and moved rows and upload only changed rows, and write bursts reach the worker as one transfer. See [the efficiency report](benchmarks/efficiency/REPORT.md).
- Both profiles now retain physical GPU row slots during moves. New rows and sparse edits upload separately, while a small row map controls their screen positions. Cursor-only compatible updates upload no cells. Ownership, malformed sources, memory growth, legacy partial uploads and row-stamp wrap are checked; 60 incremental frames match the previous GPU pixels exactly. See [the retained-row report](benchmarks/retained-rows/REPORT.md).

- The SGR action pass removes temporary RGB/palette normalization arrays and applies supported style/color combinations atomically, preserving upstream parser hooks and extended-state handling. The compatible dense pipeline improves 14.5%, the dashboard 17.8%, and a longer dense batch 13.3%. Native code is unchanged. See [the SGR report](benchmarks/sgr-actions/REPORT.md).

The latest measurements are in [the broader workflow study](benchmarks/workflows/REPORT.md),
[the GPU visual-option study](benchmarks/gpu-visual-options/REPORT.md), and
[the public scrolling validation](benchmarks/selection-retention/REPORT.md).
Each retains its own source hashes and limits. The [SGR report](benchmarks/sgr-actions/REPORT.md),
[retained-row report](benchmarks/retained-rows/REPORT.md), [efficiency report](benchmarks/efficiency/REPORT.md),
and [optimization report](benchmarks/optimization/REPORT.md) preserve the earlier binaries' measurements.

## Prioritized implementation backlog

| Priority | Investment                                                    | Why it matters                                                                    | Proof required                                                                                |
| -------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Done     | GPU search decorations, link hover, contrast and transparency | These ordinary visual features now retain GPU rendering                           | Original-addon tests plus actual alpha pixels, contrast differential checks and retained rows |
| P0       | Input scheduling and latency instrumentation                  | A fast average can coexist with delayed keystrokes or large pauses                | Local input-to-visible-echo distribution, main-thread long tasks and frame-miss counts        |
| P0       | Separate model lifetime from GPU lifetime                     | Device loss currently makes the native profile terminate its worker               | Simulated loss/recovery preserves text, history, modes, selections and ordered pending writes |
| P1       | Bounded multi-page glyph atlas with generations               | A single 2048-square atlas can reset or overflow on large Unicode/Retina scenes   | Atlas exhaustion, font changes, mixed scripts and stale-reference tests                       |
| P1       | Shared device/pipeline/atlas resources where ownership allows | Each terminal currently owns another GPU device and RGBA atlas                    | 1/4/8/16-terminal resource and responsiveness measurements                                    |
| P1       | Smaller compositor-only Wasm artifact                         | The compatible renderer downloads code for native parsing/shaping it does not use | Cold-load and first-correct-frame comparisons; unchanged APIs and consumers                   |
| P1       | Complete rendering and input conformance corpus               | Public API shape alone does not establish visual or protocol parity               | Differential state, pixels, keyboard/IME and real application traces                          |
| P2       | Persistent render target with damage rendering                | Sparse changes still redraw the entire canvas                                     | GPU pass timings; scroll, cursor, transparency and resize correctness                         |
| P2       | SIMD, upload staging rings, compact glyph draw lists          | These may improve specific bottlenecks after larger waste is removed              | Per-platform measurements showing a meaningful benefit without regressions                    |

## CPU, copies and the terminal core

1. Profile parsing, snapshot extraction, attribute decoding, glyph lookup, packing, Wasm copies, GPU submission and browser paint independently. Use a profiling build for Ghostty/Wasm function attribution. RGB churn is a separate parser workload: the native parser is not universally faster than xterm's JavaScript parser in the recorded tests.
2. Build a guarded numeric glyph path and eventually a glyph-ID ABI. The current scalar cache is a first step. An immutable glyph descriptor can hold UV coordinates, bearings, dimensions and color mode once instead of repeating coordinates in every cell. Keep explicit underline colors and wide/continuation semantics when evaluating a 20-byte or smaller cell layout.
3. Persistent Wasm staging is implemented. Continue measuring its independent effect, since copy removal alone does not establish a throughput gain in a parser-heavy workload. Refresh views after growth, validate ranges, and keep ownership explicit. WebGPU still performs its required data snapshot/upload.
4. Reduce retained native text allocation using scalar/cluster IDs or inline small text, while preserving the public cell/text/selection behavior. Use row arenas or reusable storage before introducing unsafe borrowed pointers into Ghostty memory.
5. Expose a stream sink that waits for write credit instead of making callers invent retry loops. Write bursts are already batched into one worker transfer.
6. Investigate why toggling reverse video (CSI ?5h) after content is drawn leaves existing native cells in their old colors; a136240 already behaves this way.
7. Budget large input processing so it cannot starve rendering or keyboard responses. Preserve UTF-8/escape state across slices and respect synchronized output. Avoid changing xterm's callback or custom-parser semantics for the compatible profile.
8. Replace per-frame sample shifts with rings, make expensive diagnostics opt-in, and remove avoidable geometry/font-string work and row wrappers after profiling confirms their cost.

Shared memory can be an optional high-throughput lane. It must retain the transferable-buffer path for ordinary embedding; browser shared memory requires a secure, cross-origin-isolated document. [SharedArrayBuffer requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)

## GPU rendering and glyph residency

1. Retained physical GPU row mapping is implemented. Next reduce logical CPU row copies and broaden cached row eligibility for combining clusters and extended attributes, with explicit mutation/atlas generations. Preserve conservative invalidation for unknown layouts and selection.
2. Merge uploads by dirty ranges and benchmark a threshold for partial-cell spans. Comparing packed cells can avoid unnecessary uploads, but it is additional CPU work; use it where the expected unchanged data justifies the comparison.
3. Experiment with a persistent backing texture for sparse damage. Swapchain contents cannot be assumed to preserve the previous image. Update damaged regions in the retained texture, then present through a copy or blit. Include the extra pass and texture bandwidth in the result.
4. Crop glyphs to ink bounds with descriptor bearings to reduce transparent overdraw. Compact the nonempty-glyph draw list for sparse logs. Dense workloads may not benefit from that compaction.
5. Evaluate an alpha-only atlas for monochrome glyphs with a separate RGBA atlas for emoji/images. The current RGBA texture consumes 16 MiB per terminal before cells, fonts and history; 16 independent atlases alone consume 256 MiB.
6. Add bounded pages, live-tile pinning, eviction generations and explicit budgets. An eviction must invalidate affected rows before a slot is reused. Never trade stale glyph references for a higher rate.
7. Prewarm common glyph/style sets without delaying the usable API. Budget cold shaping/raster work and measure time to a correct image separately from warm-frame speed. Handle CSS webfonts finishing loading, font fallback changes and DPR changes as atlas epochs.
8. Reuse a device and pipelines on the same rendering owner. For the native worker profile, a shared rendering worker is a possible design; GPU devices cannot simply be assumed transferable between dedicated workers. Measure fairness and fault isolation before adopting pooling.
9. Keep the frame queue bounded so throughput does not turn into latency. Do not introduce a synchronous GPU fence on every normal frame. A queue-completion fence establishes completed submitted work, not physical screen presentation. [GPUQueue completion semantics](https://gpuweb.github.io/types/interfaces/GPUQueue.html)

GPU timestamps are the right optional probe for render-pass duration. Their availability is feature-dependent; asynchronously resolve/read a bounded query ring and keep unsupported devices functional. This measures GPU command duration, not per-process device utilization. [WebGPU timestamp-query sample](https://webgpu.github.io/webgpu-samples/?sample=timestampQuery)

## Feature completeness and everyday quality

| Area           | Work to cover                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decorations    | Search matches, active-match colors, overview rulers, foreground/background layers, link underlines and custom decorations without a whole-terminal renderer switch                                  |
| Visual options | Contrast adjustment, transparency, correct selection tint, cursor modes, faint/inverse/hidden/underline/strike/overline behavior, fractional DPR and letter spacing                                  |
| Text           | Wide cells, combining marks, supplementary scalars, emoji/ZWJ/variation sequences, fallback fonts, ligatures/character joiners, font bearings and line-height seams                                  |
| VT behavior    | Chunked UTF-8 and controls, margins/origin, wrap/reflow, erase/insert/delete, alternate screens, synchronized output, queries/replies and scrollback anchors                                         |
| Input          | Keyboard modes, modifiers, AltGraph/dead keys, IME/composition, mobile keyboards, paste, focus reporting, mouse modes and browser shortcut handling                                                  |
| Interaction    | Smooth trackpad scrolling, reliable selection across history/reflow, word/line selection, link hit testing, copy formatting, sticky-bottom behavior and resize transitions                           |
| Accessibility  | Screen readers, keyboard-only navigation, focus, reduced-motion behavior, announcements that do not flood the user, and correct textarea/candidate-window positioning                                |
| Images         | Explicitly scoped Kitty/iTerm/Sixel support, decoded resource budgets and asynchronous decode/upload; native Kitty graphics ship; placeholders, animation timing and Sixel remain                    |
| Large history  | Bounded memory, fast search/indexing, stable line identifiers and efficient serialization; preserve synchronous original-addon contracts, and offer separate async native features where appropriate |

Use the pinned core and protocol references as behavioral authorities. Ghostty's VT support does not automatically mean its desktop frontend features or every graphics protocol are exposed through this bridge. [Ghostty architecture](https://ghostty.org/docs/about), [VT protocol reference](https://ghostty.org/docs/vt)

## Reliability, safety and maintainability

- Preserve the terminal model through recoverable GPU failure, sleep/resume and renderer replacement. Rebuild texture/buffer state from authoritative cells, use DOM where that profile permits it, and bound retries.
- Bound history, atlas pages, queues, image decoding and control-string work. Test extreme combining clusters, malformed byte streams and invalid compositor ranges. Logical text correctness and rendering resource limits need separate policies.
- Keep remote clipboard writes, external navigation and downloaded resources within explicit host/browser permissions. OSC replies, title changes and link providers must not become an implicit HTML execution path.
- Stress dispose-during-init, worker termination, queue rejection, observer cleanup, repeated mount/unmount and rapid resizing. Verify resources return close to baseline after teardown.
- Keep the pinned private xterm boundary small and documented. The optional attribute/content words are optimizations; getter-based paths remain available. Run conformance and installed-package checks before any upstream upgrade.
- Generate/check ABI layout constants, maintain WGSL/Rust layout assertions, preserve dependency notices, and add native fuzz/sanitizer checks for the C boundary. The existing stable-state owner and synchronous callback discipline must survive performance refactors.
- Instrument cache occupancy, evictions, upload bytes, queue age, cold glyphs, renderer state, long tasks and high-percentile latency. Expose diagnostics for developers without making telemetry or profiling a mandatory hot-path cost.

## Integration and release quality

Keep the common setup to a constructor, `open`, `write`, and the stylesheet. Continue testing installation as `wraithterm` and as an alias for `@xterm/xterm`, with original addons. Consumers should receive prebuilt assets and never need Rust or Zig toolchains.

Add production fixtures for Vite, Webpack/Rspack, Rollup/esbuild and Next.js/SSR; React Strict Mode, hidden tabs, split panes, CSP, CDN/asset-base loading and versioned caching. Separate the compatible compositor download from the native engine if it materially improves startup. Test ESM and the documented Node require behavior rather than implying universal CommonJS support.

Provide small framework wrappers, a resize helper, binary WebSocket/stream examples, an optional backend PTY example, precise API references and a capability matrix. Framework wrappers should dispose correctly and not require state updates on every frame. Runtime errors should explain an actionable capability/asset problem, while fallback normally keeps the terminal usable.

Ship an experimental npm release first. A stable release requires the correctness, presentation and resource gates below, not only a successful publish dry run.

## Acceptance gates and measurement discipline

| Gate                  | Proposed target / verification                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 120 Hz                | Real 120 Hz presentation tests on named reference hardware; 99% of presentation opportunities met in sustained representative traces; report missed frames and stalls |
| CPU headroom          | Dense 240×80 reference scene: parser + pack + submission p95 under 4 ms and p99 under 6 ms; cold/rare glyph bursts reported separately                                |
| Input latency         | Controlled local echo p95 under 16 ms, including scheduling and presentation; distinguish remote transport latency                                                    |
| Idle                  | No unnecessary redraw; target under 0.5% of one CPU core for a stationary terminal, measured with the same diagnostic settings                                        |
| Resource scaling      | 1/4/8/16 terminals, bounded atlas/history/queues, fair scheduling and teardown returning resources near baseline                                                      |
| Compatibility         | Public API, original addons, protocol fixtures, visual options, keyboard/IME and accessibility on all declared support tiers                                          |
| Recovery              | No lost terminal state after transient surface failure or recoverable device loss; no hanging writes/disposal                                                         |
| 1000-update/s stretch | Publish grid, styling, input volume, font/DPR, actual submitted/completed frames and latency; require a repeatable named workload                                     |

For this dense scene, 1000 updates/s means about 19.2 million cells, 4.8 million SGR changes and roughly 205 MiB of input per second. The current 20-byte layout would upload about 384 MB of cells per second before other copies. Parsing alone is around a millisecond in prior measurements, so GPU micro-optimization cannot by itself deliver that target.

Build replay corpora from append-only logs, compiler output, tmux/Neovim/btop, color churn, atlas exhaustion, cold Unicode, resizing and multiple terminals. Pin inputs and versions. Alternate before/after order, warm consistently, retain outliers, verify text/geometry/pixels, and report distributions and source/binary hashes. Run CPU/GPU profiling separately from the primary speed benchmark. Use isolated hardware for resource attribution and repeated sustained runs for confidence.

requestAnimationFrame is normally synchronized to the display's refresh cadence; the current headless browser is not a 120 Hz physical-display test. [requestAnimationFrame behavior](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)

Implementation order: finish allocation reductions and transient-presentation recovery; retain rows through scrolling; support common decorations/contrast on GPU; add latency/recovery/cross-browser gates; then evaluate the compact ABI, smaller compositor artifact and resource pooling. Keep changes only when correctness and the relevant workload both improve.
