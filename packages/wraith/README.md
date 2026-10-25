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
| xterm.js, DOM    |        37.7 ms |
| xterm.js + WebGL |         9.8 ms |
| **Wraith**       |     **2.5 ms** |

That is **15× less** than xterm.js DOM and **3.9× less** than xterm.js + WebGL, and we are still climbing.

<sub>Medians of interleaved runs, Chrome 155, Apple M5 Max, GPU-completed updates ([report](docs/benchmarks/launch/REPORT.md)). Your machine will differ: [race it yourself](https://wraithterm.com/#race).</sub>

</td>
<td width="50%">

<img src="https://raw.githubusercontent.com/betterclever/wraithterm/main/.github/assets/numbers.jpg" alt="15× less CPU than xterm.js DOM, 3.9× less than xterm.js + WebGL" width="100%">

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
term.connect(new WebSocket(ptyUrl));
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

Connect a PTY transport:

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

`connect()` sends input as binary WebSocket messages and accepts output as text,
ArrayBuffer, or Blob, preserving order. Your backend owns PTY creation, geometry,
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

### Share a terminal

```sh
npx wraithterm serve --share                     # owner link + read-only viewer link
npx wraithterm serve --share=write               # adds a collaborator link that can type
npx wraithterm serve --share --record demo.cast  # also records asciicast v2
```

With `--share` (or `--record`), every link attaches to one PTY and sees the same
output. Each role has its own random per-run token, compared in constant time:

| Link         | Sees output | Types | Sets the size |
| ------------ | ----------- | ----- | ------------- |
| Owner        | yes         | yes   | yes           |
| Collaborator | yes         | yes   | no            |
| Viewer       | yes         | no    | no            |

The server drops viewer input and resize messages, so read-only does not
depend on the page. Viewers and collaborators render at the owner's grid,
scaled down to fit their window or letterboxed. Every page shows how many
owners, collaborators and viewers are connected. The session ends when the
command exits. Without `--share` or `--record`, each tab still gets its own
PTY.

- **Late joiners** get a replay of the current screen. The server keeps the
  output since the last full reset (`ESC c`, or cursor home followed by erase
  display outside the alternate screen), along with owner resizes, and restores
  tracked modes (DEC private modes such as cursor keys, mouse reporting and
  bracketed paste; keypad; cursor style; title). The replay is capped at
  2 MiB. If more output arrives with no reset, the oldest output is dropped and
  replay resumes at a line boundary with the modes in effect there. A
  full-screen app that has redrawn only part of its screen since then can look
  incomplete until it redraws.
- **Backpressure** is per client. The PTY never waits for viewers. A client
  with more than 4 MiB queued stops receiving live output and shows as
  "resyncing". When its socket drains, it gets a terminal reset and the replay,
  so it skips ahead to the current screen. In the
  [burst benchmark](docs/benchmarks/serve-share/README.md), a socket that never
  read did not slow the owner's 48 MiB burst.
- **`--record <file>`** writes [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/):
  output (`"o"`) and owner resizes (`"r"`). Keystrokes are not recorded. The
  file is created with mode 0600. It does contain everything the command
  prints, so treat it like a terminal log.

Links bound to `127.0.0.1` work on that machine only. To share with someone
else, forward the port (`ssh -L 7681:127.0.0.1:7681 host`) or put the server
behind an HTTPS proxy or tunnel. Browsers expose WebGPU only in secure
contexts, so a plain `http://` LAN address cannot render Wraith. `--host`
prints the same warning as before: anyone with the owner or collaborator link
can type into your shell.

## API contracts

| Method / event                                              | Contract                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Wraith.mount(element, options)`                            | Resolves after engine and pipeline initialization; fits by default.                                                  |
| `write(string \| Uint8Array)`                               | Resolves after parsing. Retains caller ownership of input buffers.                                                   |
| `flush()`                                                   | Renders pending state and waits for a GPU completion fence.                                                          |
| `resize(cols, rows)` / `fit()`                              | Preserves state through Ghostty's reflow.                                                                            |
| `setFontSize(cssPixels)`                                    | Change text size while retaining the worker, terminal state and scrollback.                                          |
| `setFont(font, { fontSize?, lineHeight?, fallbackFonts? })` | Atomically replace OpenType fonts and optional geometry; invalid fonts leave the renderer usable.                    |
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
