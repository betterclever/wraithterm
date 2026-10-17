# Architecture

Wraith separates terminal semantics, rendering, and browser integration. The
`Wraith.mount()` terminal model never crosses JavaScript as a JSON screen or an array of cell
objects. Each `Wraith.mount()` instance owns a worker, a Wasm module, and a GPU device.

```mermaid
flowchart LR
    App[Application / PTY transport] --> SDK[TypeScript SDK]
    SDK -->|owned byte buffers / commands| Worker[Dedicated worker]
    Worker -->|one Wasm instance| Ghostty[libghostty-vt]
    Ghostty -->|C ABI / changed rows| Core[Retained Rust snapshot]
    Core --> Text[HarfRust / swash / glyph atlas]
    Text --> GPU[Rust wgpu / WGSL]
    GPU --> Canvas[OffscreenCanvas / WebGPU]
    Ghostty -->|responses / input encoding| Worker
    Worker --> SDK
```

## Ownership

`Core` owns a Ghostty bridge handle and a stable Rust `State` allocation. The State's address
remains stable when Core moves. Its internal raw owner prevents an owning Box
field from being retagged while foreign code retains a userdata pointer. Public
snapshot access is read-only. Ghostty callbacks may borrow it only synchronously,
inside a write or render-state update. No callback reenters the terminal. The bridge
is freed before the State, and uses Rust allocation callbacks for every Ghostty
allocation. There are no competing Zig and Rust heaps.

`native/bridge.c` is the sole translation layer for upstream C structs, sized
struct initialization, and enum constants. Rust exposes its own small `Frame`
layout. A pinned Ghostty revision and C compilation isolate upstream API churn.
The build extracts the public `ghostty_type_json()` ABI manifest from the exact
native or Wasm archive being linked. It generates inline readers for cell tags,
widths, style IDs and codepoints, avoiding generic per-cell queries. Unknown
schemas or incompatible descriptors stop the build. Both targets compare those
readers against libghostty's getters on 100,130 raw cells before compiling the
bridge. Styles and grapheme text still use the public out-of-line APIs; no private
packed layout is frozen in the source.

`Renderer` owns the device, surface, pipeline, atlas texture, cell storage buffer,
row map, uniform buffer, and CPU staging cells. `Atlas` owns font bytes, shaping metadata,
the swash scaler context, and a bounded cache keyed by grapheme and style.

The SDK copies caller-owned input once before transferring it to the worker.
String input is encoded once. Wasm bindings copy input into Wasm memory. Inside
Wasm, changed cells are copied into retained Rust storage; they do not make an
expensive trip through JavaScript. WebGPU performs its required upload copies.
This is deliberately not described as an entirely zero-copy pipeline.

## A frame

1. libghostty-vt parses a streaming byte sequence and updates terminal state.
2. The worker coalesces presentation through requestAnimationFrame. Idle state
   produces no redraw, except cursor or text blinking.
3. Ghostty updates its incremental render snapshot. The adapter visits dirty rows
   and copies their grapheme, colors, and flags into reusable Rust cell storage.
4. Atlas hits reuse an existing tile. A miss chooses a fallback font, shapes the
   grapheme with HarfRust, rasterizes with swash, and schedules one texture upload.
5. Each changed cell becomes a 20-byte GPU record: colors, flags and one glyph
   word (atlas slot, ink width, color bit). Rows that only moved are copied
   by libghostty row id and raw cells instead of re-read. A visible-to-physical row
   map retains their GPU slots. Only new or revised rows are uploaded; adjacent
   logical sources with adjacent physical destinations merge into one write.
   The GPU cell buffer stays resident between frames.
6. A single render pass issues two instanced draw calls: backgrounds first, then
   glyphs and decorations. This prevents a wide glyph from being covered by the
   next cell's background. Glyph sampling uses explicit LOD 0, so per-cell branches
   do not violate WGSL derivative-uniformity rules.
7. The command buffer is submitted and the surface texture is presented. Dirty
   flags clear only after successful submission.

Moving a cursor may dirty its previous and new rows, following Ghostty's damage
model. Scrolling changes a four-byte mapping entry per viewport row and uploads
only newly packed content. Each physical slot has one visible owner, so editing
duplicate rows cannot overwrite each other. Identity maps bypass the shader's
row lookup. Resizing replaces the slots and initializes every visible row.

## Input and output

Keyboard and mouse events are encoded by Ghostty, using its current modes. This
keeps legacy application cursor keys, modifiers, and Kitty keyboard behavior in
the terminal core. Browser code owns focus, composition events, pointer selection,
clipboard gestures, and safe activation of HTTP(S)/mailto OSC 8 links.

Terminal-generated replies share the same byte event path as user input.
Title and bell effects have separate typed events. Selection anchors belong to
Ghostty, so copying can use its formatter rather than reconstructing logical
lines from pixels.

The worker serializes commands. In particular, an asynchronous GPU fence holds a
Rust borrow until completion. Previously queued animation callbacks are canceled
or guarded while that borrow is active. This prevents a render callback from
recursively mutating a borrowed Wasm object.

## Bounds and failures

The grid is limited to 512 per dimension and 65,536 cells, and pixel dimensions
must fit the GPU's texture limits. The atlas is 2048×2048 RGBA. If a new glyph set
would exceed capacity, it resets and rebuilds all visible rows in the same frame.
If the visible set itself exceeds capacity, rendering reports an explicit error
rather than reusing live tiles. Font bytes remain independent of atlas entries.

Synchronized output preserves the last completed snapshot. A 150 ms worker timer
releases an abandoned hold when it can safely access the engine. GPU-fenced
benchmark batches and explicit flushes do not block the application UI thread.

Pipeline creation checks a WebGPU validation scope before mount resolves. Runtime
GPU errors retain the first diagnostic and reach `onError`; outstanding work is
rejected and the worker is terminated. Device-loss recovery currently means
remounting a terminal. Teardown disposes listeners, ResizeObserver, timers, DOM,
the Wasm owner, and GPU resources; a stalled worker is terminated after a bounded
wait.

## Where to extend

| Area                                         | File / module                            |
| -------------------------------------------- | ---------------------------------------- |
| Upstream ABI and effects                     | `native/bridge.c`                        |
| Headless state ownership and snapshots       | `crates/wraith-engine/src/core.rs`       |
| Shaping, fallback, rasterization, cache      | `crates/wraith-engine/src/text.rs`       |
| Uploads, device, surface, render pass        | `crates/wraith-engine/src/gpu.rs`        |
| GPU row ownership and upload coalescing      | `crates/wraith-engine/src/retained.rs`   |
| Cell geometry and visual styles              | `crates/wraith-engine/src/terminal.wgsl` |
| Wasm public engine bindings                  | `crates/wraith-engine/src/web.rs`        |
| Scheduling, protocol, benchmarks             | `packages/wraith/src/worker.ts`          |
| Browser API, input, transport, accessibility | `packages/wraith/src/index.ts`           |

Performance work should be driven by a recorded workload and percentile evidence.
Broad compatibility additions should add a failing protocol fixture and, where
visual behavior is involved, a browser pixel assertion.

## xterm-compatible profile

`Terminal` inherits the official, pinned xterm 6.0 core. Its renderer adapter is
isolated in `xterm-internals.ts`. `xterm-input.ts` installs instance-local fast
paths for complete semicolon RGB/palette colors and common SGR style combinations.
The upstream parser still accumulates parameters, dispatches every handler and
owns asynchronous continuation. Unsupported or mixed/colon attributes use the
original actions; tentative fast-path changes stay local until the whole sequence
is validated. Extended-attribute resets and hyperlink retention use upstream's
action. Guards reject unfamiliar private layouts, and no upstream prototype is
modified. This additional private boundary must be retested on xterm upgrades.
`xterm-api.d.ts` and the CSS are generated from that pinned package, with the MIT
notice preserved. An internal npm dependency alias prevents recursion when users
install Wraith as `@xterm/xterm`.

The synchronous constructor and `open()` keep the original DOM/input tree and
services. The adapter transfers ownership of the original DOM renderer through
xterm's `MutableDisposable.clearAndLeak()` and installs a composite renderer.
The adapter then owns its fallback, canvas, subscriptions, timer and compositor.
Replacement by another renderer or terminal disposal releases all of them. An
instance disposed during GPU initialization immediately frees a late result.

Warm scalar glyphs use numeric cache keys referencing the same text/style tiles.
Combining clusters retain the string path. Ordinary adjacent attribute runs
reuse one decoded style; extended attributes bypass that optimization. These
paths read the guarded three-word BufferLine storage through the private adapter.
Ordinary scalar cells bypass public cell loading; combined text, extended
attributes, invalid scalars and unfamiliar row layouts retain getter behavior.

The compositor owns a reusable Wasm arena containing cell words, four dimensions
and eight frame words, followed by one previous-row source index per visible row.
JavaScript packs directly into views of that allocation, then submits a retained
frame. Rust reserves reusable physical slots before assigning new rows. This removes the three binding
allocations and JS-to-Wasm array copies from the compatible redraw path. GPU
upload copies remain. Bounds and device storage limits are checked before use.

Views refresh when configuration changes or Wasm memory grows. A cold glyph
upload can detach them during packing; the adapter refreshes the views and
repeats the affected row before submission. Arena slots use `UnsafeCell` to make
their JS write ownership explicit. Writes and synchronous Rust slice consumption
must not overlap, and rendering remains paused during benchmark fences.

Buffers, float views and uniforms are reused. Every packed cell overwrites its
complete record, including a zero glyph word for blank and continuation cells.
A failed surface acquisition retains pending presentation and damage until an
actual submission. The native worker retries at its next animation opportunity;
the compatible renderer requests another redraw.

xterm's render service coalesces changed row ranges. The adapter reads those rows
from the authoritative buffer, reuses compositor-owned staging storage, and uses a
borrowed-text glyph cache with four bold/italic variants. Browser Canvas2D handles
CSS font rasterization on misses. Atlas exhaustion resets and repacks the full
viewport before submission, avoiding stale references. If a visible glyph set
still exceeds capacity, the DOM renderer takes over.

The Rust `Compositor` has no terminal parser or font allocation. It validates
geometry and upload ranges and shares the resident cell buffer, texture, shaders,
render pass and submission code with the native Ghostty renderer. xterm's
callbacks, events and buffer reads keep their original timing; write callbacks
indicate parsed state, rather than GPU completion.

Transparency, minimum contrast, character joiners, buffer decorations and link
hover currently delegate rendering to the retained DOM renderer. This is a
behavior-preserving fallback; the GPU profile resumes when those conditions end.
Selection, modes and input remain xterm-owned throughout. Browser rendering and
parser costs differ from the libghostty worker profile, so its benchmark numbers
cannot be assigned to the compatibility profile.
