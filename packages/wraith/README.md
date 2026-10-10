# Wraith

**Rust / Wasm / WebGPU terminals. Full xterm.js API or a lean libghostty core.**

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

Open **http://127.0.0.1:5173**. Try `help` or `colors`, start a stream, and run a
benchmark. The playground's shell is an interactive demonstration; connect a PTY
backend to run actual programs.

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

## API contracts

| Method / event                                              | Contract                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Wraith.mount(element, options)`                            | Resolves after engine and pipeline initialization; fits by default.                 |
| `write(string \| Uint8Array)`                               | Resolves after parsing. Retains caller ownership of input buffers.                  |
| `flush()`                                                   | Renders pending state and waits for a GPU completion fence.                         |
| `resize(cols, rows)` / `fit()`                              | Preserves state through Ghostty's reflow.                                           |
| `onBytes(listener)`                                         | Byte-accurate PTY input and terminal query responses; preferred for transports.     |
| `onData(listener)`                                          | UTF-8 text view of output. Use `onBytes` for binary mouse protocols.                |
| `onResize`, `onTitleChange`, `onBell`, `onStats`, `onError` | Return disposable subscriptions.                                                    |
| `paste(text)`                                               | Removes terminal control characters and follows bracketed paste mode.               |
| `scroll(lines)`                                             | Negative moves toward history; positive moves toward the active area.               |
| `getText()`                                                 | Plain text for the current viewport, with visual row breaks.                        |
| `getText(true)`                                             | Ghostty's selection formatter; unwraps soft-wrapped lines.                          |
| `setTheme({ foreground, background, cursor })`              | Colors use `#rrggbb`.                                                               |
| `benchmark({ workload, frames, warmup })`                   | Exclusive, warmed render benchmark; restores the main screen and cursor visibility. |
| `dispose()`                                                 | Rejects outstanding work and releases the worker, DOM, listeners, and engine.       |

The default maximum unacknowledged input is **8 MiB**. `write()` rejects with
`BackpressureError` when full. Await writes to regulate a high-throughput producer.
`write()` resolves before presentation; `flush()` provides the stronger completion
contract.

The bundled JetBrains Mono font covers the demo. Supply `font` and `fallbackFonts`
as URLs or Uint8Arrays for other scripts or color emoji. Font size is in CSS pixels;
rasterization uses devicePixelRatio captured at mount. The accessible text mirror
is enabled with `screenReaderMode: true`.

## Architecture and compatibility

Read [ARCHITECTURE.md](docs/ARCHITECTURE.md) for ownership, the frame path, and
failure handling. [COMPATIBILITY.md](docs/COMPATIBILITY.md) distinguishes verified
behavior from upstream capabilities and remaining renderer work.

This release implements a broad text-terminal path. **Kitty graphics / Sixel,
OSC 52 clipboard operations, cross-cell ligatures, contextual script runs, and
cross-browser certification remain release work.** This is not a claim of complete
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

The [efficiency report](docs/benchmarks/efficiency/REPORT.md) has the current
before/after numbers for both profiles, with pixel-identical output. The
[engineering plan](docs/TOP_TIER.md) prioritizes GPU feature coverage, scrolling,
latency, recovery, memory, compatibility and integration for a stable release.
Earlier passes: [optimization](docs/benchmarks/optimization/REPORT.md),
[packing](docs/benchmarks/packing/REPORT.md) and
[utilization](docs/benchmarks/comparison/UTILIZATION.md).
