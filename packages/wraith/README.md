<p align="center">
  <a href="https://wraithterm.com">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/betterclever/wraithterm/main/.github/assets/logo-light.svg">
      <img src="https://raw.githubusercontent.com/betterclever/wraithterm/main/.github/assets/logo.svg" alt="Wraith" width="560">
    </picture>
  </a>
</p>

<h3 align="center">Spooky fast web terminal.</h3>

<p align="center">
  Ghostty's terminal engine and a Rust WebGPU renderer, compiled into one Wasm module.<br>
  Drop it in where xterm.js was, or run Ghostty itself in a worker.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/wraithterm"><img alt="npm" src="https://img.shields.io/npm/v/wraithterm?style=flat-square&color=ffb86b&labelColor=0c0806"></a>
  <a href="https://github.com/betterclever/wraithterm/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/betterclever/wraithterm/ci.yml?branch=main&style=flat-square&label=ci&color=ffd98a&labelColor=0c0806"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-ff7f6e?style=flat-square&labelColor=0c0806"></a>
  <img alt="xterm.js 6.0 compatible" src="https://img.shields.io/badge/xterm.js-6.0%20compatible-d9bbff?style=flat-square&labelColor=0c0806">
  <img alt="WebGPU" src="https://img.shields.io/badge/WebGPU-Rust%20%2B%20Wasm-ffb86b?style=flat-square&labelColor=0c0806">
</p>

<p align="center">
  <a href="https://wraithterm.com"><b>Website</b></a> ·
  <a href="https://wraithterm.com/#race"><b>Race it in your browser</b></a> ·
  <a href="docs/ARCHITECTURE.md"><b>Architecture</b></a> ·
  <a href="docs/PERFORMANCE.md"><b>Performance</b></a> ·
  <a href="CHANGELOG.md"><b>Changelog</b></a>
</p>

## Why Wraith

<table>
<tr>
<td width="50%">

**Less CPU per update.** One dense, full-screen update (240×80 cells, about 4,800 style changes):

| Renderer         | CPU per update |
| ---------------- | -------------: |
| xterm.js, DOM    |        20.4 ms |
| xterm.js + WebGL |         5.1 ms |
| **Wraith**       |     **1.1 ms** |

That is **18× less** than xterm.js DOM and **4.6× less** than xterm.js + WebGL, and we are still climbing.

<sub>Medians of interleaved runs, Chrome 155, Apple M5 Max, GPU-completed updates, Wraith 0.5.0 ([report](docs/benchmarks/v0.5/REPORT.md)). Your machine will differ: [race it yourself](https://wraithterm.com/#race).</sub>

</td>
<td width="50%">

<img src="https://raw.githubusercontent.com/betterclever/wraithterm/main/.github/assets/numbers.jpg" alt="18× less CPU than xterm.js DOM, 4.6× less than xterm.js + WebGL" width="100%">

</td>
</tr>
</table>

- **Two ways in.** `wraithterm/xterm` is a complete xterm.js 6.0 `Terminal`: keep your code and addons, get a WebGPU renderer. `Wraith.mount()` runs Ghostty's own `libghostty-vt` in a worker.
- **Built for the GPU.** 20-byte cells, glyph quads sized to their ink, and row reuse: a one-cell edit uploads one row.
- **Off your main thread.** The native profile parses, snapshots and renders in a dedicated worker; your app keeps its frame budget.
- **One module, one allocator.** Zig owns the terminal model; Rust owns shaping, the glyph atlas and wgpu, in a single Wasm binary.

<p align="center">
  <img src="https://raw.githubusercontent.com/betterclever/wraithterm/main/.github/assets/dashboard.jpg" alt="A btop-style dashboard rendered live by Wraith: CPU meters, a braille network graph, a process table, highlighted Rust, logs and a frame-time histogram." width="100%">
  <br><sub>A full-screen dashboard rewritten every update, rendered live by Wraith on WebGPU.</sub>
</p>

## Quick start

```sh
npm i wraithterm
```

```ts
// Keep your xterm.js code: swap one import.
import { Terminal } from 'wraithterm/xterm';
import 'wraithterm/css/xterm.css';

const term = new Terminal({ fontSize: 14 });
term.open(document.getElementById('terminal')!);
term.write('hello from the other side\r\n');
```

```ts
// Or go native: Ghostty's terminal semantics in a worker.
import { Wraith } from 'wraithterm';

const term = await Wraith.mount(document.getElementById('terminal')!);
term.connect(ptyUrl); // the worker opens the socket and parses its output
```

## About this repository

The `Wraith.mount()` profile is built around upstream
`libghostty-vt`. Zig owns the terminal model; Rust owns text shaping, glyph
rasterization, and the WebGPU renderer. Both live in **one Wasm module with one
allocator**, inside a dedicated worker. TypeScript handles browser input and the
public API.

The initial performance target is a **1 ms warm frame processing budget**, with
120 Hz presentation on capable displays. GPU-completed render throughput is
measured separately from the screen's refresh rate. See [the measured results](docs/PERFORMANCE.md).

## Run the playground

The prebuilt engine and font are included. Node 22.12+ is sufficient to run the
demo; Rust and Zig are needed only when changing the engine.

```sh
npm ci
npm run build:sdk
npm run dev
```

Open **http://127.0.0.1:5173** for the landing page and its in-browser race, or
**http://127.0.0.1:5173/playground.html** for the playground. In the playground,
try `help` or `colors`, start a stream, and run a benchmark. The playground's shell is an interactive demonstration; connect a PTY
backend to run actual programs.

Open **http://127.0.0.1:5173/pipes.html** for the [Pipes lab](docs/PIPES.md): a shaded
3D pipe network drawn entirely with ANSI truecolor half-blocks. The default XP
mode grows one pipe, or a chosen count, then clears and starts a new layout. Choose Wraith,
xterm WebGL or DOM, switch between live geometry and replay, or run the same
scene in another terminal with `npm run pipes -- --preset inferno`.

## Drop-in xterm API

Wraith 0.2 exports a complete xterm.js **6.0.0** `Terminal` with original public
methods, events, options, parser hooks, buffer views and addon contracts:

```ts
import { Terminal } from 'wraithterm/xterm';
import 'wraithterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';

const terminal = new Terminal({ fontSize: 14, scrollback: 10_000 });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.querySelector('#terminal')!);
fit.fit();
terminal.write('Hello, \x1b[36mworld\x1b[0m\r\n');
terminal.onData((data) => socket.send(data));
```

This profile retains xterm's semantic core and uses Wraith's Rust/Wasm WebGPU
compositor. The `Wraith.mount()` profile below retains libghostty. Original Fit,
Search, Serialize, Attach and Unicode11 addons are verified. Some visual features
use automatic DOM fallback; [XTERM_API.md](docs/XTERM_API.md) gives the exact
contracts, fallback list, and instructions to retain **unchanged `@xterm/xterm`
imports** by installing the package under that dependency key.

Open **http://127.0.0.1:5173/xterm.html** for the compatibility playground.

## Integrate

The package is `wraithterm`; it has not been published to npm. Install
the supplied `.tgz`, use the local package directory, or build your own package:

```sh
npm run build:sdk
npm pack --workspace wraithterm
```

Give the host an explicit height:

```html
<div id="terminal" style="height: 420px"></div>
```

```ts
import { Wraith } from 'wraithterm';

const terminal = await Wraith.mount(document.querySelector('#terminal')!, {
  fontSize: 14,
  scrollback: 10_000,
});

await terminal.write('Hello, \x1b[36mworld\x1b[0m\r\n');
terminal.onData((input) => console.log(input));
terminal.focus();
```

Many terminals in one tab share workers through a pool:

```ts
const pool = Wraith.pool({ workers: 4 });
const terminals = await Promise.all(panes.map((el) => Wraith.mount(el, { pool })));
```

Pooled terminals keep their own canvas, engine, scheduling, search and fences,
but share each worker's thread, Wasm instance and WebGPU device. On an Apple M5
Max, 128 pooled terminals run in one tab in about 1.9 GiB. 128 dedicated
terminals run out of memory, and xterm.js + WebGL draws only 16 of them
([report](docs/benchmarks/pool/REPORT.md)). Heavy output in one pooled
terminal can delay frames for its worker's neighbours; dispose terminals before
`pool.dispose()`.

For hundreds or thousands of terminals, let each worker draw all of its
terminals into one shared WebGPU surface:

```ts
const pool = Wraith.pool({ workers: 4, surface: 'shared' });
const terminal = await Wraith.mount(host, { pool }); // same API as before
```

Each worker owns one page-sized canvas layered above the page
(`pointer-events: none`), one device, one compiled pipeline and one glyph atlas
per font configuration. Each terminal is drawn at its host's on-screen
rectangle, clipped to scrolling ancestors. Only terminals with new content are
redrawn, and off-screen terminals do no GPU work. Hosts keep their DOM input,
focus, selection and accessibility. Shared and per-canvas output are
pixel-identical at 1:1 (`npm run test:fleet`). Headed on an Apple M5 Max at
120 Hz with agent-log streams, 1,000 shared terminals sustained 41–49 updates
per terminal per second against 5.9–6.8 for a per-canvas pool, and 256 held
119/s against 23–28 ([report](docs/benchmarks/fleet/REPORT.md)). Try it in
[`demo/fleet.html`](demo/fleet.html).

Limits: the shared canvases sit at `z-index: 1` by default
(`sharedSurface: { zIndex, container }`), so overlays meant to cover terminals
must stack above them. Placement follows layout one animation frame later
than the DOM. Rotation and perspective transforms are not modelled, and partial
CSS opacity or filters on a host are not applied (`visibility: hidden` and
`opacity: 0` do hide it). Fallback fonts and ligatures are fixed when a shared
terminal is created. A worker's terminals with the same fonts share one
2048×2048 glyph atlas; when together they need more glyphs than it holds, it
resets and every terminal repacks (one full redraw), so a glyph mix that never
fits keeps resetting.
`pool.surfaceStats` reports presented and GPU-completed frames per worker.

Connect a PTY transport. Given a URL, the terminal's worker opens the WebSocket
itself: output is parsed there and never crosses the page's main thread, and
keystrokes, paste and terminal replies are sent from the worker in order.

```ts
const connection = terminal.connect('wss://your-backend/terminal');

// This control message is a convention for YOUR server, not terminal output.
// send() is queued until the socket opens and ordered with keystrokes.
const sendSize = () =>
  connection.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
sendSize();
terminal.onResize(sendSize);

// Resolves after the close and every byte received before it are parsed.
connection.closed.then(() => terminal.write('\r\n[session ended]\r\n'));
```

`connect(url, { protocols?, stream? })` accepts `ws:`, `wss:`, `http(s):` or a
path relative to the page. Where `WebSocketStream` exists (Chrome), the worker
reads only as fast as it parses, so a slow page pushes back on the server through
TCP; elsewhere it parses each `WebSocket` message as it arrives. The connection
has `opened` and `closed` promises, `onOpen`, `onClose` and `onError`, `send()`,
`close(code?, reason?)` and `dispose()`. Connecting again closes the previous
worker socket; disposing the terminal closes it too. There is no automatic
reconnect.

To keep a socket on the page, pass the `WebSocket` itself:

```ts
const socket = new WebSocket('wss://your-backend/terminal');
const connection = terminal.connect(socket);

// This control message is a convention for YOUR server, not terminal output.
const sendSize = () => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
  }
};
socket.addEventListener('open', sendSize);
terminal.onResize(sendSize);

// Cleanup:
connection.dispose();
await terminal.dispose();
```

Both forms send input as binary WebSocket messages and accept output as text,
ArrayBuffer, or Blob (page socket only), preserving order. Your backend owns PTY creation, geometry,
authentication, and transport lifecycle.

For Vite, add the included adapter so dependency prebundling preserves the worker
and font URLs. Both dev mode and a production build are verified with the installed
npm archive:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { wraith } from 'wraithterm/vite';

export default defineConfig({ plugins: [wraith()] });
```

Other bundlers must preserve the `new URL(..., import.meta.url)` worker and asset
references; they have not yet been certified.

## React, Vue, Svelte and `<wraith-term>`

The package ships bindings for React, Vue 3, Svelte and plain HTML. Each one is a
thin wrapper around one shared lifecycle controller. React, Vue and Svelte are
optional peer dependencies and are never bundled. No binding needs a compiler
plugin: React is written without JSX, Vue uses `defineComponent` + `h`, and the
Svelte action is plain JavaScript. Importing any binding is safe during server
rendering; the engine is loaded with `import()` on mount, in its own chunk.

All bindings take the same configuration:

| Field       | Meaning                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`   | `'native'` (default): `Wraith.mount()`. `'xterm'`: the xterm.js-compatible `Terminal` (import `wraithterm/css/xterm.css`).                                                                                                |
| `options`   | `WraithOptions`, or xterm `ITerminalOptions` with `profile: 'xterm'`. `theme`, `fontSize`, `lineHeight`, `font` and, for a terminal mounted with `fit: false`, `cols`/`rows` update live; `fit` itself is fixed at mount. |
| `src`       | A WebSocket URL (or an open `WebSocket`) connected once mounted, through `connect()` with backpressure. Sockets made from a URL close on unmount.                                                                         |
| `autoFocus` | Focus the terminal when ready.                                                                                                                                                                                            |
| events      | `onReady(terminal)`, `onData(string)`, `onBytes(Uint8Array)`, `onTitleChange`, `onBell`, `onResize({cols, rows})`, `onError(Error)`.                                                                                      |

Other options (`scrollback`, `pool`, `ligatures`, …) apply at mount; remount to
change them (a React `key`, a Vue `:key`). A `profile` change remounts by itself.
Event handlers are read when an event fires, so passing new closures each render
costs nothing. Give the host an explicit height.

**React** (18 or 19, StrictMode-safe):

```tsx
import { useRef } from 'react';
import { Wraith, type WraithHandle } from 'wraithterm/react';

export function Shell() {
  const term = useRef<WraithHandle>(null);
  return (
    <Wraith
      ref={term}
      style={{ height: 420 }}
      options={{ fontSize: 14, theme: { background: '#0e1217' } }}
      src="wss://your-backend/terminal"
      onReady={() => term.current?.write('connected\r\n')}
      onTitleChange={(title) => (document.title = title)}
    />
  );
}
```

The ref exposes `terminal` (the `Wraith` or `Terminal`, null until ready),
`ready`, `write()` (queued until ready) and `focus()`. Other props go to the host
`<div>`. StrictMode's mount → cleanup → mount disposes the discarded terminal as
soon as its mount settles, exactly once.

**Vue 3**:

```ts
import { h } from 'vue';
import { Wraith } from 'wraithterm/vue'; // or app.use(WraithPlugin)

export default {
  setup: () => () =>
    h('div', { style: 'height: 420px' }, [
      h(Wraith, {
        options: { fontSize: 14 },
        src: 'wss://your-backend/terminal',
        onData: (data: string) => console.log(data),
        onReady: (terminal) => terminal.focus(),
      }),
    ]),
};
```

In templates: `<Wraith :options="{ fontSize: 14 }" src="wss://…" @data="send" @title-change="setTitle" />`.
Events are `ready`, `data`, `bytes`, `title-change`, `bell`, `resize`, `error`; a
template ref exposes `terminal`, `ready`, `write()` and `focus()`.

**Svelte** (an action for any Svelte version, and an attachment for Svelte 5.29+):

```svelte
<script>
  import { wraith, terminal } from 'wraithterm/svelte';
  let fontSize = $state(14);
</script>

<div style="height: 420px" use:wraith={{ options: { fontSize }, onData: (d) => send(d) }}></div>

<div style="height: 240px" {@attach terminal({ profile: 'xterm', src: 'wss://your-backend/terminal' })}></div>
```

The action's `update` applies changed parameters to the live terminal; Svelte
reruns an attachment when its parameters change, which remounts. Pass
`controller: (c) => …` to get `c.ready`, `c.terminal` and `c.write()`.

**`<wraith-term>`** (any framework, or none):

```html
<script type="module">
  import 'wraithterm/element';
</script>
<wraith-term src="wss://your-backend/terminal" font-size="14" style="height: 420px"></wraith-term>
```

Attributes: `profile`, `cols`, `rows`, `font-size`, `line-height`, `scrollback`,
`theme` (JSON, e.g. `'{"background":"#101820"}'`), `ligatures`, `screen-reader`,
`fit`, `autofocus`, `src`. Giving `cols` or `rows` at mount turns fitting off unless
`fit` is present; adding them to a fitting terminal later only logs a warning. The `options` property merges anything an attribute cannot carry
(fonts, a pool). Events are `CustomEvent`s that bubble: `wraith-ready`,
`wraith-data`, `wraith-bytes`, `wraith-title`, `wraith-bell`, `wraith-resize` and
`wraith-error`, with the value in `detail`. The element exposes `terminal`,
`ready`, `write()` and `focus()`. Moving it within the document keeps its
terminal; removing it disposes the terminal. Its default style is
`display: block; height: 360px`, at zero specificity.

With Vite, use the `wraith()` plugin above; it excludes every binding subpath from
dependency prebundling. `npm run test:frameworks` installs the packed archive into
fresh React (StrictMode), Vue, Svelte and `<wraith-term>` Vite apps, then checks in
Chrome, under both the dev server and a production build, that each terminal
renders text and pixels, receives typed input and its title, and that
unmounting terminates every worker it created. It also checks that the `src`
attribute round-trips over a real WebSocket, that the xterm profile reaches
WebGPU, and that a Svelte parameter change updates the terminal without a new
worker.

## Your shell in a tab

```sh
npx wraithterm serve
```

This opens your shell in a native Wraith terminal in the browser. Everything that
runs in a terminal works: vim, htop, `kitten icat`, Kitty graphics apps. Pass a
command after `--` to run it instead of your shell, and `--open` to launch the
browser. The PTY needs [node-pty](https://github.com/microsoft/node-pty), a native
module that the library does not depend on. On first use, `serve` offers to install
it into `~/.cache/wraithterm`.

The server binds to `127.0.0.1` and prints a URL with a random per-run token. The
page, its PTY WebSocket and same-origin checks all require it. `--host` exposes a
shell to your network, so use it only on networks you trust. The PTY runs with
`TERM=xterm-256color`, `COLORTERM=truecolor` and `TERM_PROGRAM=wraith`. Tested on
macOS and Linux; Windows ConPTY through node-pty is untested.

## API contracts

| Method / event                                              | Contract                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Wraith.mount(element, options)`                            | Resolves after engine and pipeline initialization; fits by default.                                                  |
| `write(string \| Uint8Array)`                               | Resolves after parsing. Retains caller ownership of input buffers.                                                   |
| `flush()`                                                   | Renders pending state and waits for a GPU completion fence.                                                          |
| `resize(cols, rows)` / `fit()`                              | Preserves state through Ghostty's reflow.                                                                            |
| `setFontSize(cssPixels)`                                    | Change text size while retaining the worker, terminal state and scrollback.                                          |
| `setFont(font, { fontSize?, lineHeight?, fallbackFonts? })` | Atomically replace OpenType fonts and optional geometry; invalid fonts leave the renderer usable.                    |
| `connect(url, options)`                                     | Worker-owned WebSocket; output parsed off the main thread. `closed` resolves after the last byte is parsed.          |
| `onBytes(listener)`                                         | Byte-accurate PTY input and terminal query responses; preferred for transports.                                      |
| `onData(listener)`                                          | UTF-8 text view of output. Use `onBytes` for binary mouse protocols.                                                 |
| `onResize`, `onTitleChange`, `onBell`, `onStats`, `onError` | Return disposable subscriptions.                                                                                     |
| `paste(text)`                                               | Removes terminal control characters and follows bracketed paste mode.                                                |
| `scroll(lines)`                                             | Negative moves toward history; positive moves toward the active area.                                                |
| `getText()`                                                 | Plain text for the current viewport, with visual row breaks.                                                         |
| `getText(true)`                                             | Ghostty's selection formatter; unwraps soft-wrapped lines.                                                           |
| `findNext(needle)` / `findPrevious(needle)`                 | Search older/newer matches across scrollback, wrap around, reveal and select the match. Resolves `{ total, index }`. |
| `clearSearch()`                                             | Cancel pending search and clear its selection.                                                                       |
| `select(start, end, rectangular?)`                          | Select inclusive viewport cell endpoints `{ x, y }`; optional block selection.                                       |
| `selectWord(x, y)`, `selectLine(y)`, `selectAll()`          | Use Ghostty's word, logical-line and complete active-screen/history selection rules.                                 |
| `clearSelection()`                                          | Remove the current selection.                                                                                        |
| `attachCustomKeyEventHandler(handler)`                      | Return false to exclude a key from terminal input; returns a disposable registration.                                |
| `setTheme({ foreground, background, cursor })`              | Colors use `#rrggbb`.                                                                                                |
| `benchmark({ workload, frames, warmup })`                   | Exclusive, warmed render benchmark; restores the main screen and cursor visibility.                                  |
| `dispose()`                                                 | Rejects outstanding work and releases the worker, DOM, listeners, and engine.                                        |

The default maximum unacknowledged input is **8 MiB**. `write()` rejects with
`BackpressureError` when full. Await writes to regulate a high-throughput producer.
`write()` resolves before presentation; `flush()` provides the stronger completion
contract.

`onRender(listener)` optionally observes native render submissions and returns a
disposable subscription. Its `{ frame }` sequence is monotonic; the event is not
a GPU fence or proof of display presentation. Worker notifications are disabled
when the final listener is removed, so unobserved rendering adds no messages.

Native `scrollback` is a physical line limit. Ghostty prunes complete internal
pages, so retention can exceed the configured count by a page; `scrollback: 0`
disables history. The independent upstream default byte cap is removed when a
positive line count is configured.

The native profile renders [Kitty graphics](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
on the GPU. Applications can transmit RGB, RGBA or PNG images directly
(base64, optionally zlib-compressed and chunked), then place, crop, scale,
layer and delete them. Replies arrive through `onBytes`. Each screen stores up
to `imageStorageLimit` decoded bytes (64 MiB by default; `0` disables Kitty
graphics), evicting the oldest images first. File, temp-file and shared-memory
transmission are unavailable in browsers. Unicode-placeholder placements, timed
animation playback and the xterm-compatible profile are not supported yet.

Native search matches ASCII letters without case sensitivity; other UTF-8 bytes
match exactly. It searches literal strings up to 4096 UTF-8 bytes. Results use
Ghostty's newest-to-oldest indexing (`-1` when no match is selected); search work
advances between worker commands, allowing input and rendering to proceed. A new
search rejects a pending request with `Search superseded`. Regular expressions
and case-sensitive search options are not exposed by this native API.

Double-click selects a word, triple-click selects a logical line, and Alt-drag
selects a rectangle. Shift overrides application mouse tracking for selection.
Keyboard hooks run in registration order outside IME composition. Return `false`
to keep the key out of terminal input; call `event.preventDefault()` in the hook
when also replacing the browser action. Dispose the registration to restore
normal handling.

Set `ligatures: true` for programming-font ligatures (`=>`, `!==`, `->`, `<|>`),
shaped across cells with HarfRust. The bundled JetBrains Mono includes them. The
run under the cursor shows its separate characters, as in kitty. Arabic, Indic,
Thai and other complex scripts are always shaped across cells. Letters join and
conjuncts form, but text stays in the terminal's left-to-right cell order: there
is no bidi reordering. Supply a font for these scripts with `fallbackFonts`.

The bundled JetBrains Mono font covers the demo. Supply `font` and `fallbackFonts`
as URLs or Uint8Arrays for other scripts or color emoji. Font size is in CSS pixels;
rasterization automatically follows devicePixelRatio changes, including with
`fit: false`. Font sizes must resolve to 6..96 physical pixels at the current
display scale (capped at 3); line height must be 1..2. Live changes preserve the
worker, grid, terminal state and scrollback. The accessible text mirror
is enabled with `screenReaderMode: true`.

## Architecture and compatibility

Read [ARCHITECTURE.md](docs/ARCHITECTURE.md) for ownership, the frame path, and
failure handling. [COMPATIBILITY.md](docs/COMPATIBILITY.md) distinguishes verified
behavior from upstream capabilities and remaining renderer work.

This release implements a broad text-terminal path and native Kitty graphics.
**Sixel, Kitty Unicode placeholders and timed animation, OSC 52 clipboard
operations, cross-cell ligatures, contextual script runs, and cross-browser
certification remain release work.** This is not a claim of complete
terminal-spec conformance.

## Build from source

Prerequisites: Rust 1.88+, the `wasm32-unknown-unknown` target, Node 22.12+, Git,
and tar. The bootstrap supports macOS and Linux on arm64 or x64. It downloads a
checksum-verified Zig 0.16.0 toolchain and the Ghostty commit in `upstream.json`.

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run build
npm run test:native
npm run typecheck
npm test
npm run build:demo
```

The distributed Wasm is optionally post-link optimized with Binaryen. Run
`npm run optimize` after a fresh engine build when `wasm-opt` is installed.

Build downloads and intermediates go under `.cache/`. Set `WRAITH_BUILD_DIR` to
use another build directory and `ZIG` to use an existing Zig 0.16.0 executable.
Consumers of the prebuilt package need neither compiler.

The bootstrap applies the revision- and hash-checked patches in `native/patches/`.
The SGR patch interns the final style once per command and retains Ghostty's
original parser and individual-attribute API. Set `WRAITH_GHOSTTY_PATCHES=0` when
building an unpatched reference; the bootstrap reverses only a recognized patch
and refuses to overwrite unfamiliar upstream edits.

For real browser verification, run the demo server in another terminal:

```sh
npm run test:browser
npm run test:xterm
npm run test:xterm-consumer
```

Set `CHROME_PATH` when Chrome is outside its standard macOS path; on Linux, install
Playwright Chromium with `npx playwright install chromium`. `WRAITH_HEADFUL=1`
shows the test browser. The suite requires a working WebGPU adapter. The software
GPU test option is `WRAITH_SOFTWARE_GPU=1`; such results must be identified as
software results, not hardware performance.

## License

Wraith is MIT licensed. Ghostty's MIT license, the font's SIL Open Font License,
and bundled Rust dependency notices accompany the package. See [licenses/](licenses/).

## Renderer comparison

The [dense-scene benchmark](docs/benchmarks/comparison/REPORT.md) compares Wraith
with xterm DOM and WebGL on a 240×80 styled Unicode scene. Run
`npm run benchmark:compare` with the demo server active, or use `/compare.html`.
Raw measurements and a separate CPU profile are retained under
`docs/benchmarks/comparison`.

The [Pipes stress report](docs/benchmarks/pipes/REPORT.md) compares a 240×80 scene
with 38,400 RGB assignments per update. Run `npm run benchmark:pipes` to reproduce
the GPU-completed comparison, or `npm run test:pipes` to check the interactive lab.

The [efficiency report](docs/benchmarks/efficiency/REPORT.md) has the current
before/after numbers for both profiles, with pixel-identical output. The
[engineering plan](docs/TOP_TIER.md) prioritizes GPU feature coverage, scrolling,
latency, recovery, memory, compatibility and integration for a stable release.
Earlier passes: [optimization](docs/benchmarks/optimization/REPORT.md),
[packing](docs/benchmarks/packing/REPORT.md) and
[utilization](docs/benchmarks/comparison/UTILIZATION.md).
