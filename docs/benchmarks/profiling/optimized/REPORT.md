# Optimized pipeline CPU profile and next performance work

Captured 2026-10-10T11:40:29.859Z from the optimized xterm-compatible profile in headless
Chrome, using the hardware WebGPU adapter reported as apple / metal-3.
The scene is 240 by 80 cells at DPR 1, with eight changing Unicode/style variants.
After 32 warmup updates, the profiler samples 1024 parse-and-redraw updates at
500 microsecond intervals. GPU completion fences occur every 32 updates.

Wasm SHA-256: `c9991d95b022a8ab9643a9e2f4e84e1af4ba80fd363135f79804e40dc3a2c986`.

## Measured attribution

These exclusive categories use the call tree to include callees of parser and
packing functions. Remaining work under the compatible renderer is grouped
separately. They sum to active sampled execution after excluding idle, program,
and root samples.

| Category                  | Sampled milliseconds | Share of active sampled execution |
| ------------------------- | -------------------: | --------------------------------: |
| parser including callees  |              1049.21 |                            44.87% |
| other renderer work       |               433.12 |                            18.52% |
| other sampled work        |                63.39 |                             2.71% |
| packing including callees |               792.86 |                            33.90% |

The `pack` function alone accounts for 25.95%
of active samples. Its inclusive group also includes buffer access, attribute
resolution, and glyph lookup. Parser work includes decoding, SGR/color handling,
and writing terminal state.

The percentages are sampled execution attribution, not CPU utilization, GPU
utilization, GPU pass duration, or physical FPS. This is a synthetic dense
workload on one busy machine. JIT inlining and sampling variance affect the
breakdown. The earlier [throughput report](../../optimization/REPORT.md) remains
the speed baseline; this capture does not establish a new throughput result.

## Proposed optimizations, in order

1. **Bulk row packing.** Read guarded, pinned xterm row storage instead of loading
   a reusable public cell for every column. Decode ordinary attribute runs once,
   retain the extended-attribute and unknown-layout fallbacks, and compare exact
   logical cells and pixels across Unicode, selection, and theme fixtures.
2. **Persistent Wasm staging memory.** Pack directly into an owned Wasm arena.
   The generated `Compositor.render` glue currently allocates and copies packed
   cells, dimensions, and frame words on each call. Refresh views after memory
   growth, validate sizes, and preserve exclusive ownership around async fences.
   This removes an intermediate JS-to-Wasm copy; GPU upload remains a copy.
3. **Compact cells and glyph descriptors.** Evaluate 24-byte packed integer UVs,
   then a 20-byte glyph-ID layout with shared descriptors. Against today's
   32-byte cell, these reduce cell payload by 25% and 37.5%, respectively.
   Descriptor fetch cost, atlas generations, and stale IDs require measurement
   and correctness checks; payload reduction is not a matching FPS claim.
4. **Retained rows for scrolling.** Introduce stable row identities, mutation
   revisions, and a logical-to-physical GPU row map. For a pure one-row scroll,
   240 new cells need 7680 bytes rather than repacking 614400 bytes for 80 rows,
   plus the row-map update. This is an 80-fold reduction in cell payload, not in
   total work or frame time. Conservative invalidation is needed when revision
   information is unavailable. A changing full-screen workload gains less.
5. **Parser and snapshot work.** Parsing accounts for a large share of this
   workload, so shader improvements alone cannot establish the 1000-update/s
   target. Profile ASCII/UTF-8 runs, style changes, and snapshot extraction within
   both existing profiles. Preserve write callbacks, inline parser hooks, live
   buffer views, effects, and byte ordering. Moving the compatible semantic core
   to a worker or replacing it with Ghostty is a separate conformance project.
6. **GPU feature coverage and presentation damage.** Render search decorations,
   link hover, contrast, and transparency on the GPU rather than switching the
   entire terminal to DOM rendering. Move selection updates into renderer state
   where possible. Evaluate a persistent backing texture for sparse damage;
   surface contents cannot be treated as retained history.
7. **Atlas and GPU resources.** Evaluate an alpha-only monochrome atlas plus an
   RGBA color atlas, bounded shared resources, and cropped glyph geometry. A
   2048-square alpha atlas has a 4 MiB base image instead of 16 MiB for RGBA;
   color-atlas and metadata costs remain additional. Sharing requires compatible
   rendering ownership and font/DPR epochs.

Start with bulk packing and persistent staging, then evaluate compact cells and
retained rows in separate commits. Keep parser optimization as an independent
track for dense full-screen throughput. Use optional asynchronous GPU timestamp
queries before making GPU duration claims. SIMD, compute shaders, and render
bundles are experiments after the measured larger costs are addressed.

Acceptance requires alternating before/after measurements, equal terminal
state and pixels, actual submitted-frame counts, CPU latency tails, and no
regression in full xterm behavior. Add append-only scrolling, sparse updates,
selection, decorated search, DPR 2, and multiple-terminal workloads so the dense
scene does not become the only optimization target.

## Reproduce

With the current playground server running:

```sh
WRAITH_REPORT_DIR=docs/benchmarks/profiling/optimized WRAITH_PROFILE_ITERATIONS=1024 node scripts/profile-renderer.mjs
```

`WRAITH_URL` and `CHROME_PATH` can override the target and browser. The raw
`wraith.cpuprofile` is retained locally and ignored by Git; the versioned summary
contains self-time and inclusive-group attribution. This capture profiles the
compatible semantic core directly and bypasses the normal public write scheduler.

The proposed copy reduction is consistent with the [WebGPU buffer upload
contract](https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/writeBuffer).
The current extra copy is also visible in the checked-in generated binding
helpers. See the [WebGPU timestamp-query sample](https://webgpu.github.io/webgpu-samples/?sample=timestampQuery)
for optional GPU duration measurement and xterm's [parser-hook lifecycle](https://xtermjs.org/docs/guides/hooks/)
for the semantic contracts a parser change must preserve.
