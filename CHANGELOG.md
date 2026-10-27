# Changelog

Release notes are generated from conventional commits by
[release-please](https://github.com/googleapis/release-please).

## [0.6.0](https://github.com/betterclever/wraithterm/compare/v0.5.0...v0.6.0) (2026-10-27)


### Features

* **a11y:** screen reader announcements, row mirror and keyboard exit ([37c7595](https://github.com/betterclever/wraithterm/commit/37c75958dbb7a93b59410a0cc6b5ce64a3e74f7d))
* add GPU post-process effects and custom WGSL shaders ([6040feb](https://github.com/betterclever/wraithterm/commit/6040feb943c1f6f8ad825d122fae7b9735eb13c4)), closes [#43](https://github.com/betterclever/wraithterm/issues/43)
* add React, Vue, Svelte and &lt;wraith-term&gt; bindings ([9b9c876](https://github.com/betterclever/wraithterm/commit/9b9c876dff587037e91f5782a03a70dc9d6eb3bb)), closes [#42](https://github.com/betterclever/wraithterm/issues/42)
* command blocks API, gutter and shell integration for both profiles ([fe489e0](https://github.com/betterclever/wraithterm/commit/fe489e0d034694b108b26eb66389cd0f3e9c131e)), closes [#48](https://github.com/betterclever/wraithterm/issues/48)
* command blocks from OSC 133 shell integration ([bd31175](https://github.com/betterclever/wraithterm/commit/bd311758b6abee5f4536740521975b63fd17358c))
* **demo:** add the effects lab with a custom shader gallery ([48d4bff](https://github.com/betterclever/wraithterm/commit/48d4bff92670d38b005ef95deefd25b1b8b3fd6a)), closes [#43](https://github.com/betterclever/wraithterm/issues/43)
* draw pooled terminals into one shared WebGPU surface per worker ([e5fbb60](https://github.com/betterclever/wraithterm/commit/e5fbb60c6b7547c66f676788a1a6e22eaddf2043)), closes [#45](https://github.com/betterclever/wraithterm/issues/45)
* **engine:** track OSC 133 command blocks with Ghostty tracked refs ([a986aa5](https://github.com/betterclever/wraithterm/commit/a986aa56e38c08bbb92fa099c81dc3cad255e658)), closes [#48](https://github.com/betterclever/wraithterm/issues/48)
* expose VT state snapshots and grid digests from the headless engine ([c08ca79](https://github.com/betterclever/wraithterm/commit/c08ca799f8e47ba218f4fefd294c89f74252bfc6)), closes [#47](https://github.com/betterclever/wraithterm/issues/47)
* GPU effects (CRT, bloom, cursor trail) and custom WGSL shaders ([a7cfb53](https://github.com/betterclever/wraithterm/commit/a7cfb5311a36233725d20275e2cdf392d8939795))
* let the engine worker own the terminal's WebSocket ([0873abe](https://github.com/betterclever/wraithterm/commit/0873abe3014ffee0855c199f36097b1ab558a0fa))
* React, Vue, Svelte and &lt;wraith-term&gt; bindings ([2b3f45b](https://github.com/betterclever/wraithterm/commit/2b3f45b9cffc3c127c232625c836743089b44874))
* record, replay and scrub terminal sessions ([a9bdbd9](https://github.com/betterclever/wraithterm/commit/a9bdbd9f9e40d0c0698a2d1f488cd1528501a7f3)), closes [#47](https://github.com/betterclever/wraithterm/issues/47)


### Performance

* batch serve's PTY output into larger WebSocket messages ([66f6f5b](https://github.com/betterclever/wraithterm/commit/66f6f5b1558c17c699c87e5dd032ab33270e2419))
* measure keystroke-to-pixel latency; render idle echoes at once ([2c66654](https://github.com/betterclever/wraithterm/commit/2c66654e721b56d4512a596df950de8b9964061d))
* open serve's WebSocket in the engine worker, off the main thread ([3f6548d](https://github.com/betterclever/wraithterm/commit/3f6548dbe0b314f7e1b0a9ccac72f53597534fb2))
* read serve's PTY from a worker thread ([a7849e2](https://github.com/betterclever/wraithterm/commit/a7849e2886139da6a32f7e8cca71dc2d2546ea49))
* read serve's PTY into a shared ring without stack traces ([1f48fa6](https://github.com/betterclever/wraithterm/commit/1f48fa67dc24724d59c67a1344dacca1aa477fd6)), closes [#60](https://github.com/betterclever/wraithterm/issues/60)
* render an idle terminal's next write at once ([7c308c3](https://github.com/betterclever/wraithterm/commit/7c308c3d19f274fda4930e420e4f9462e78636dd)), closes [#59](https://github.com/betterclever/wraithterm/issues/59)
* stop re-layerizing the page on every unfocused cursor move ([94b0ec7](https://github.com/betterclever/wraithterm/commit/94b0ec70ad0fe683bdb4e3e220c6cda866114966)), closes [#45](https://github.com/betterclever/wraithterm/issues/45)
* warm up the first engine in each worker during idle time ([73f9788](https://github.com/betterclever/wraithterm/commit/73f9788e727252a102b268b3bb2fc8f53486138c))
* warm up the Wasm engine; measure SIMD and build flags ([c787121](https://github.com/betterclever/wraithterm/commit/c787121fb4960382a507a5cdce8e0cf4f703c824))


### Bug fixes

* **a11y:** hold accessibility config until the worker has started ([c266ed4](https://github.com/betterclever/wraithterm/commit/c266ed47e0e5503f85aa868c8b1d3517bc245002))
* **a11y:** show the focus ring only for the focus a Tab caused ([c252051](https://github.com/betterclever/wraithterm/commit/c2520512212e8232d9c3152108fde7691d36c5ce))
* **bindings:** stop live grid changes on fitting terminals and late onReady ([e42377a](https://github.com/betterclever/wraithterm/commit/e42377a1549cfcf9d711f0bc433bb8b482fec3d7))
* correct bash integration cmdlines for unsaved and non-ASCII commands ([db6df0c](https://github.com/betterclever/wraithterm/commit/db6df0c696b0f2e0e9c0d19d6aa78db6e1fbfa2f))
* drop the worker socket when the terminal fails ([75ca66b](https://github.com/betterclever/wraithterm/commit/75ca66bd26ecc5b5446891610b1344cffa06a0fb))
* **effects:** survive dispose during setEffects and restore trail after reduced motion ([bda3871](https://github.com/betterclever/wraithterm/commit/bda3871c1a2f37fc8cdc6477a70c969654a5fd6c))
* **engine:** report blocks erased by clear as truncated ([34489dc](https://github.com/betterclever/wraithterm/commit/34489dc7889a4b4946f7f10e36de34fe2a51c916))
* fall back to the typed command in the native profile ([a30dca5](https://github.com/betterclever/wraithterm/commit/a30dca55f2316eedfe98dcc517f459cba447489a))
* hide styled-hidden and re-clip moved hosts on shared surfaces ([9908ea9](https://github.com/betterclever/wraithterm/commit/9908ea9302538a342732558ca2b4d9b7047bcf44))
* ignore command-block replies while a terminal disposes ([00e893e](https://github.com/betterclever/wraithterm/commit/00e893e450b05bc0d82eb8a24a555be22b566f99))
* keep internal player seeks from raising unhandled rejections ([50b2a72](https://github.com/betterclever/wraithterm/commit/50b2a72ac8f3e8075735463d2b560725f0f2e971)), closes [#47](https://github.com/betterclever/wraithterm/issues/47)
* keep Wraith.player from deadlocking under top-level await ([ee33a8b](https://github.com/betterclever/wraithterm/commit/ee33a8be168b9c0ab803ad72725df74a90f43f2e))
* read grid digests inside synchronized output without releasing it ([1567485](https://github.com/betterclever/wraithterm/commit/1567485220fc8644ed08c7a905a89795643068b4)), closes [#47](https://github.com/betterclever/wraithterm/issues/47)
* record resizes in the order the worker applies them ([415563b](https://github.com/betterclever/wraithterm/commit/415563b574f2c13a644dbe414e097e5e3e1bff62))
* **serve:** stop the PTY reader thread before node-pty closes the master ([92f242e](https://github.com/betterclever/wraithterm/commit/92f242ee8c75bcd26351e50f70b08d15a8a496a8))


### Documentation

* **a11y:** describe what announcements: 'always' actually gates on ([accbcc0](https://github.com/betterclever/wraithterm/commit/accbcc0217aab75040ff3bb8e50637af3a655c0d))
* document accessibility and compare it with wterm ([564fb28](https://github.com/betterclever/wraithterm/commit/564fb28b7a2027086ee114018eb1c62cb6a088b5))
* document command blocks and measure their overhead ([3de3011](https://github.com/betterclever/wraithterm/commit/3de3011d1435ff25ff3cac5f920890ae064d98c6)), closes [#48](https://github.com/betterclever/wraithterm/issues/48)
* document framework bindings and add a &lt;wraith-term&gt; demo ([5c3723e](https://github.com/betterclever/wraithterm/commit/5c3723eeb9c9c8342ee88ee89a0472daedf2bccb)), closes [#42](https://github.com/betterclever/wraithterm/issues/42)
* document recording, asciicast and the scrubbable player ([87514b5](https://github.com/betterclever/wraithterm/commit/87514b589458ea0863817efacd3c1439d675a7d2)), closes [#47](https://github.com/betterclever/wraithterm/issues/47)
* measure and document GPU effects ([de0790f](https://github.com/betterclever/wraithterm/commit/de0790f6c32df91c36fb02cee974170eb8ebaa4f)), closes [#43](https://github.com/betterclever/wraithterm/issues/43)
* record replay seek latency on a 10-minute session ([0ef13cd](https://github.com/betterclever/wraithterm/commit/0ef13cda54f846152b7e0553bfbb79e07863d90b)), closes [#47](https://github.com/betterclever/wraithterm/issues/47)
* rename engine warm-up report and state its measurement limits ([2de5b0f](https://github.com/betterclever/wraithterm/commit/2de5b0fa2cfc3b57916ad5f26cd0a3a7c1c102cf))
* report the headed fleet benchmark and document shared surfaces ([53ecd08](https://github.com/betterclever/wraithterm/commit/53ecd08f84980003686ad61bd9f798b5f1b3d6e7)), closes [#45](https://github.com/betterclever/wraithterm/issues/45)
* state shared atlas capacity and opacity limits in both READMEs ([127d4a3](https://github.com/betterclever/wraithterm/commit/127d4a3ee9130f137cecef404cc8454cb1290fce))
* state that recordings start empty ([1cf25a3](https://github.com/betterclever/wraithterm/commit/1cf25a34d3c81b177cb4d9790d37a6297e6d1745))


### Benchmarks

* **a11y:** measure screen reader mode overhead and record validation ([66fab23](https://github.com/betterclever/wraithterm/commit/66fab23681d5e52ae5e1097de437287246a99b32))
* add engine-only throughput, first-content and worker profile harnesses ([c2dc4be](https://github.com/betterclever/wraithterm/commit/c2dc4be69ab34cd1d3b573cc955b70bc41701901))
* add headed fleet benchmark for shared vs per-canvas pools ([df8b8db](https://github.com/betterclever/wraithterm/commit/df8b8dbc3f62e424ea6a911ff07b16c56461b85f)), closes [#45](https://github.com/betterclever/wraithterm/issues/45)
* make the native-Ghostty scripts portable across concurrent runs ([5dc8e63](https://github.com/betterclever/wraithterm/commit/5dc8e63cc18a24997392edea8665fcd0819efd9c)), closes [#60](https://github.com/betterclever/wraithterm/issues/60)
* measure keystroke-to-pixel latency through serve ([d255384](https://github.com/betterclever/wraithterm/commit/d255384de8b81bfb21f5f39fcce90fe9197b73a0)), closes [#59](https://github.com/betterclever/wraithterm/issues/59)
* record serve's ring reader against [#57](https://github.com/betterclever/wraithterm/issues/57), with a browserless client ([a05efe2](https://github.com/betterclever/wraithterm/commit/a05efe23f87cfd4d5d440879adc165f94eceb835)), closes [#60](https://github.com/betterclever/wraithterm/issues/60)

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
