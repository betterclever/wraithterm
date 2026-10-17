# Changelog

Release notes are generated from conventional commits by
[release-please](https://github.com/googleapis/release-please).

## [0.3.0](https://github.com/betterclever/wraithterm/compare/v0.2.0...v0.3.0) (2026-10-10)


### Features

* **demo:** rebuild the native and xterm.js playgrounds ([1026cc7](https://github.com/betterclever/wraithterm/commit/1026cc757c429358dc186c51256874863afa2c2a))
* **site:** a pixel ghost that follows the pointer through the hero terminal ([6f0ca9e](https://github.com/betterclever/wraithterm/commit/6f0ca9e4256f10f7fcc730623ad7cf55991f667a))
* **site:** a snappy ghost and a glyph trail behind the pointer ([5a0034f](https://github.com/betterclever/wraithterm/commit/5a0034f48048ddfec1bbd18fef5fca2e1dea2e09))
* **site:** Manrope, a Labs section, a warm favicon and a terminal pipeline ([951e53d](https://github.com/betterclever/wraithterm/commit/951e53d59a8a551d5a64a6aecf367b106bd92626))
* **video:** a font picker with a live preview of every screen ([d062366](https://github.com/betterclever/wraithterm/commit/d062366e2d64c75e3932117f2bac0820083a89c7))
* **video:** a slower build, real glyph art for "How fast?", fewer screens ([4b6a9d5](https://github.com/betterclever/wraithterm/commit/4b6a9d52dbf682f2a8bf8162862cc949d7fc957e))
* **video:** lead into the drop with "The spooky fast web terminal…" ([a5e51b5](https://github.com/betterclever/wraithterm/commit/a5e51b5d326744ce22f75065537c87f74627acc3))
* **video:** set the launch video in the chosen fonts ([a9990e2](https://github.com/betterclever/wraithterm/commit/a9990e244dd536de2a33cbe70456429cf686e487))


### Documentation

* drop the banner that repeated the README logo ([297973e](https://github.com/betterclever/wraithterm/commit/297973eb2bfdd7f426f5d0266858b8c56a40e0fd))
* tagline the README "Spooky fast web terminal." ([275d8c7](https://github.com/betterclever/wraithterm/commit/275d8c76be8719c66c1ff3189f631dc04d649125))

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
