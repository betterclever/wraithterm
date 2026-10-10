# Changelog

Release notes are generated from conventional commits by
[release-please](https://github.com/googleapis/release-please).

## 0.2.0 (2026-10-11)

The first public release.

### Features

- `wraithterm/xterm`: a complete xterm.js 6.0 `Terminal` with original methods, events,
  options, parser hooks, buffer views and addon contracts, rendered by Rust on WebGPU.
- `Wraith.mount()`: Ghostty's `libghostty-vt` and the renderer in one Wasm module, inside a
  dedicated worker, with an ordered PTY transport.
- A live dashboard workload and an in-browser race against xterm.js at wraithterm.com.

### Performance

- 20-byte GPU cells, glyph quads sized to their ink, and row reuse in both profiles: a
  one-cell edit uploads one row.
- Fewer libghostty queries per cell and batched SDK writes.
- On a dense 240×80 scene, 2.5 ms of CPU per update versus 37.7 ms for xterm.js DOM and
  9.8 ms for xterm.js + WebGL (Chrome 155, Apple M5 Max;
  [report](docs/benchmarks/launch/REPORT.md)).

### Bug fixes

- Synthetic bold no longer collapses glyphs such as `i` in the native renderer.
- Block elements and braille tile without seams in the xterm-compatible renderer.
