# Changelog

Release notes are generated from conventional commits by
[release-please](https://github.com/googleapis/release-please).

## [0.5.0](https://github.com/betterclever/wraithterm/compare/v0.3.0...v0.5.0) (2026-10-24)


### Features

* bring validated terminal performance and demos into review ([320eee6](https://github.com/betterclever/wraithterm/commit/320eee6f53712b285024e96d20ac3dff94cf0311))
* **cli:** run your shell in a tab with wraithterm serve ([40607f0](https://github.com/betterclever/wraithterm/commit/40607f0ce3192bfdb97140eff01c601020e4b3c2))
* **cli:** your shell in a tab with wraithterm serve ([5a1ab5e](https://github.com/betterclever/wraithterm/commit/5a1ab5ef183f321b2ea9266e1cc822bda839650d))
* **demo:** grow continuous XP pipes through a rotating 3D scene ([c1f8c35](https://github.com/betterclever/wraithterm/commit/c1f8c353ea450ce5da258b7a513b613681ee9ca8))
* **native:** add history search, selection and keyboard hooks ([488a2f3](https://github.com/betterclever/wraithterm/commit/488a2f33d404b728304fab17ab11f1c3e40a6a6c))
* **native:** add history search, selection gestures and keyboard hooks ([e3fe564](https://github.com/betterclever/wraithterm/commit/e3fe564afcf6e9d561a9c89109e83a67e46dea6b))
* **native:** enable Kitty graphics in the terminal core ([bd6cb0a](https://github.com/betterclever/wraithterm/commit/bd6cb0aec28f56fd7ca50e9729306727047c6e2f))
* **native:** expose optional render submission notifications ([44a975a](https://github.com/betterclever/wraithterm/commit/44a975a8060a3b7daffe54c1c85525f0e3896973))
* **native:** Kitty graphics on WebGPU ([638b454](https://github.com/betterclever/wraithterm/commit/638b45405bf277e2320354c49fa31b848f3e4413))
* **native:** ligatures and complex-script run shaping ([15936f3](https://github.com/betterclever/wraithterm/commit/15936f3449766a1cf7fd7e87e37b9c3adccf66a4))
* **native:** render Kitty graphics on WebGPU ([705d683](https://github.com/betterclever/wraithterm/commit/705d68325d22943766536a74b3f54227f16d4365))
* **native:** share workers and GPU devices across terminals ([64c1d7a](https://github.com/betterclever/wraithterm/commit/64c1d7ab7c1b8fd863d170f9793766ebade63f61))
* **native:** support live fonts and display scale changes ([c364123](https://github.com/betterclever/wraithterm/commit/c3641231295844eb3c28188fe47cd7af9e2014d6))
* **native:** support live fonts, zoom and display scale changes ([049c0ba](https://github.com/betterclever/wraithterm/commit/049c0bad2279d64344579b7eadf4a9681d632394))
* **native:** terminal pool for many terminals in one tab ([7ceea66](https://github.com/betterclever/wraithterm/commit/7ceea66158d9dc9dc4343817e52cbd41f4e7c125))
* **site:** add a Kitty graphics lab ([afc6050](https://github.com/betterclever/wraithterm/commit/afc6050da9989189a595e2c0de9a4c27444fd3f2))
* **xterm:** render transparency and minimum contrast on WebGPU ([3645588](https://github.com/betterclever/wraithterm/commit/36455882af074890ae2513f8a332b57223232d27))


### Performance

* accelerate compatible bulk text across wrapped rows ([a12280b](https://github.com/betterclever/wraithterm/commit/a12280b87196e07dad0bde7ad0a8987bef6df5da))
* **ghostty:** decode cells from generated public ABI layouts ([445b7b2](https://github.com/betterclever/wraithterm/commit/445b7b2da0a2acca31f976c132027e0f7a87f3ac))
* **ghostty:** inline SGR attribute parsing ([5d6043c](https://github.com/betterclever/wraithterm/commit/5d6043ca03f17b0e2b07f9851c4c52e87846294d))
* **ghostty:** intern SGR styles once per command ([76bdae0](https://github.com/betterclever/wraithterm/commit/76bdae005b70f7c102306350960b7fa6da47747f))
* **ghostty:** read ordinary cells from bulk row views ([d06e87a](https://github.com/betterclever/wraithterm/commit/d06e87a134b37aef6c883efbaff8e7ec116b82ad))
* **input:** streamline CSI entry and generated dispatch ([e7158f9](https://github.com/betterclever/wraithterm/commit/e7158f911428bb1ce504b6176cbe4b861c7614f7))
* **native:** cache search pages and yield without timer clamping ([cb3e7d5](https://github.com/betterclever/wraithterm/commit/cb3e7d5a0451417f4982fef67b41a8a138128625))
* **native:** remove search timer delays and cache history pages ([2255e2e](https://github.com/betterclever/wraithterm/commit/2255e2e95b5e07e5bdec75619f8559954ab534d7))
* **native:** suspend normal GPU draws outside visible panels ([2e747ea](https://github.com/betterclever/wraithterm/commit/2e747ea6bf24a780cacf359b1ca52724856c0f1c))
* stop native GPU draws for hidden terminal panels ([a206cf3](https://github.com/betterclever/wraithterm/commit/a206cf3a36449dc829796eb59880787fa9417d30))
* **xterm:** bulk print fixed-width text across wrapped rows ([7bbfee6](https://github.com/betterclever/wraithterm/commit/7bbfee6d19f11fd6c65b0fa5df7c87b82d8d9c99))
* **xterm:** preserve the compact single-row print path ([efc9574](https://github.com/betterclever/wraithterm/commit/efc95749aa4141b10b38fa081c41e180b969ff29))
* **xterm:** resolve optional visual attributes from packed row words ([ef77d0d](https://github.com/betterclever/wraithterm/commit/ef77d0d32f05765077c5d9bc98007d2d3b1b6e2b))
* **xterm:** retain GPU rows for unchanged selection refreshes ([ded1ef1](https://github.com/betterclever/wraithterm/commit/ded1ef1d70eb0334d3aabc2333c7f604e48faa1c))


### Bug fixes

* **native:** honor configured scrollback line retention ([d58d63b](https://github.com/betterclever/wraithterm/commit/d58d63bd4ea132310727d046283bb5f895f1c6d2))
* **native:** honor configured scrollback line retention ([ebf484b](https://github.com/betterclever/wraithterm/commit/ebf484b58984760d3c5a2461ca8c1504180fc8f3))


### Documentation

* **bench:** publish controlled browser terminal comparison ([0fd9c8e](https://github.com/betterclever/wraithterm/commit/0fd9c8e23d12758f096144c0dc98cfa43dcc7925))
* **bench:** record 452 terminal workflow and resource runs ([3400232](https://github.com/betterclever/wraithterm/commit/3400232f58bf6846d0e792801a2a940f642bcbe5))
* **bench:** retain counted-search gains and undecorated controls ([84c668a](https://github.com/betterclever/wraithterm/commit/84c668af5c8dacbdbb62e403e4a9cb314b5ad472))
* **bench:** retain hidden-panel efficiency and visible CPU controls ([e65f309](https://github.com/betterclever/wraithterm/commit/e65f309904c23b0d3ac58efd2f2b615f893f3ce7))
* **bench:** retain paired wrapped-text gains and fallback controls ([92f85e3](https://github.com/betterclever/wraithterm/commit/92f85e35caf37a0cdbdf7aed52c4cd682dae01db))
* **bench:** retain repeated GPU visual-option comparisons ([84b3d67](https://github.com/betterclever/wraithterm/commit/84b3d672fe55a443efb0fb17ba884472a60d16ed))
* describe native Kitty graphics and record streaming throughput ([7289db3](https://github.com/betterclever/wraithterm/commit/7289db3a14c4b396ff481b120a10aef9c52242a6))
* document the terminal pool and record many-terminal results ([b35b3a6](https://github.com/betterclever/wraithterm/commit/b35b3a647e5e74da48e1424b9cb11c3e710de7c3))


### Chores

* release 0.5.0 ([c17715a](https://github.com/betterclever/wraithterm/commit/c17715a9e05ab2257bc0eeb08afcadd0535a4940))

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
