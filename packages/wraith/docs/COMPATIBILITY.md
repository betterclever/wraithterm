# Compatibility

The complete xterm.js 6.0 public API is available through `Terminal`. It uses the
pinned upstream semantic core with Wraith's WebGPU compositor and automatic DOM
fallback. Original Fit, Search, Serialize, Attach and Unicode11 addons, unchanged
npm imports, and strict consumer types are verified. See [XTERM_API.md](XTERM_API.md)
for the complete surface and exact rendering limitations.

The protocol matrix below describes the separate **libghostty `Wraith.mount()`
profile**. Its remaining work does not imply missing xterm methods in `Terminal`.

Wraith uses upstream libghostty-vt at the commit in `upstream.json`, rather than
an independently invented escape-sequence parser. That gives it a substantial
terminal model, but complete browser-terminal conformance also depends on the
renderer, input path, effects, fonts, and browser integration.

## Implemented and verified

| Area                                                                            | Verification                                                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Streaming UTF-8, split CSI/OSC sequences                                        | Every split boundary of a Unicode/SGR fixture; one-byte Wasm writes.                                |
| Cursor positioning, save/restore, delayed wrap                                  | Native protocol fixtures.                                                                           |
| Insert/delete/erase, BCE, scrolling margins, origin mode                        | Native fixtures with expected visible contents.                                                     |
| Alternate screen and main-screen restoration                                    | Native and packaged Wasm fixtures.                                                                  |
| Bounded scrollback, viewport scrolling, resize reflow                           | Native contents checks.                                                                             |
| ANSI indexed and 24-bit color, colon syntax                                     | Exact cell color assertions.                                                                        |
| Bold, synthetic italic, faint, inverse, hidden, blink                           | Core styles and implemented renderer flags; visual sample in Chrome.                                |
| Single/double/curly/dotted/dashed underlines, underline color, strike, overline | Core style flags and WGSL implementations; underline/strike pixels in demo.                         |
| DEC line drawing                                                                | Expected Unicode box drawing and Chrome sample.                                                     |
| Wide and combining characters                                                   | Cell widths, tail cells, combined clusters, clipboard text fixtures.                                |
| OSC title and bell                                                              | Native and browser effect paths.                                                                    |
| Device attributes, version, cursor, size, color-scheme reports                  | Registered effects and native fixtures.                                                             |
| Synchronized output                                                             | Snapshot hold, release, and deadline recovery.                                                      |
| OSC 8 hyperlinks                                                                | Core URI lookup; browser modifier-click handler restricts URL schemes.                              |
| Selection                                                                       | Real pointer selection in Chrome; Ghostty formatter unwraps soft-wraps.                             |
| Live native font and display-scale changes                                      | Chrome font/zoom/DPR tests; invalid replacements preserve the existing renderer and terminal state. |
| Native history search and navigation                                            | Ghostty incremental search; browser history/Unicode/reflow/wraparound/cancellation tests.           |
| Word, logical-line, block and select-all gestures/APIs                          | Ghostty selection rules, native tests and real Chrome double/triple-click and Alt-drag.             |
| Custom keyboard event handlers                                                  | Disposable hooks; Chrome verifies intercepted keys emit no terminal bytes.                          |
| Legacy / application arrows and Kitty keyboard disambiguation                   | Packaged Wasm byte-for-byte encoding tests.                                                         |
| Programming ligatures (opt-in) and complex-script run shaping (native profile)  | Native atlas tests; Chrome WebGPU pixels for ligatures, cursor split and joined Arabic.             |
| Kitty graphics (native profile): RGB/RGBA/PNG, zlib, chunked direct transfer    | Native protocol tests; Chrome WebGPU pixels for placement, scaling, z-layers and deletion.          |
| Kitty graphics crop, offsets, layers, retransmission, scrolling, replies, limit | Native protocol tests (`tests/kitty.rs`), including first/last-row and sub-cell placements.         |
| SGR mouse encoding, focus reports, bracketed paste                              | Native encoder path; browser paste test and sanitized frame contents.                               |
| IME commits and preedit placement                                               | Browser composition test; cursor coordinates anchor the input element.                              |
| Accessible viewport mirror                                                      | Optional role=log mirror, exercised in browser lifecycle test.                                      |
| Input ownership and backpressure                                                | Original buffer survives transfer; oversize write rejects.                                          |
| Multiple instances and disposal                                                 | Browser independent instance test and repeated Wasm allocation plateau test.                        |
| WebGPU rendering                                                                | Chrome pipeline validation and actual screenshot pixel assertions.                                  |

The installed default font does not cover every Unicode character. Fonts affect
visual coverage independently of the terminal model's Unicode support.

## Remaining release work

| Area                                            | Current status                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Kitty graphics remainder / Sixel                | No Unicode placeholders, timed animation or xterm profile support; no Sixel.        |
| OSC 52 / Kitty clipboard protocol               | No terminal-initiated browser clipboard read/write bridge. User paste/copy works.   |
| Bidi and the xterm-compatible profile's shaping | Native runs shape in cell order with no bidi reordering; xterm profile per cell.    |
| Bidi behavior                                   | No separate browser bidi layout pipeline.                                           |
| Native font discovery                           | Explicit bundled / supplied font data; no browser system-font rasterizer.           |
| Full screen-reader certification                | Optional text mirror is implemented; assistive-technology auditing remains.         |
| Native regex / case-sensitive search            | Literal ASCII-insensitive search is exposed; these advanced options remain.         |
| WebGL/Canvas fallback                           | WebGPU-only; unsupported environments receive an actionable initialization error.   |
| Firefox / Safari certification                  | Capability checks exist; the current recorded browser suite is Chrome on macOS.     |
| xterm.js addon compatibility                    | Available through the separate `Terminal` profile; see XTERM_API.md.                |
| Complete terminal-spec certification            | Requires expanded upstream fixtures, vttest, and real PTY/TUI integration coverage. |

The first release should keep this matrix current rather than advertise an
unqualified “full support” badge. Sixel, the remaining Kitty graphics features,
script-run shaping, and cross-browser/TUI certification are the next compatibility
milestones.
