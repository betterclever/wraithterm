# xterm.js drop-in API

Wraith 0.2 provides the complete published **xterm.js 6.0.0 public API**. `Terminal`
inherits the pinned upstream implementation and its exact public declarations.
Parser hooks, modes, synchronous buffer views, keyboard/mouse input, clipboard
behavior, accessibility, events and addons use xterm's authoritative state.
Wraith replaces the visual renderer with its Rust/Wasm/WebGPU compositor.

This profile deliberately uses xterm's semantic core. `Wraith.mount()` remains the
separate libghostty worker profile. A full xterm API cannot be obtained by renaming
Ghostty methods: asynchronous parser interception and private addon services have
observable contracts. Keeping the actual upstream core preserves those contracts
and makes compatibility reviewable.

## Change the import

```ts
import { Terminal } from 'wraithterm/xterm';
import 'wraithterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';

const terminal = new Terminal({
  cols: 80,
  rows: 24,
  scrollback: 10_000,
  fontFamily: 'ui-monospace, monospace',
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.querySelector('#terminal')!);
fit.fit();
terminal.write('Hello\r\n', () => {
  console.log(terminal.buffer.active.getLine(0)?.translateToString(true));
});
terminal.onData((data) => socket.send(data));
terminal.onBinary((data) => {
  const bytes = Uint8Array.from(data, (char) => char.charCodeAt(0));
  socket.send(bytes);
});
// This PTY server control-message format belongs to your backend.
terminal.onResize((size) => socket.send(JSON.stringify({ type: 'resize', ...size })));
terminal.focus();
```

`Terminal` is also exported from the package root. The `/xterm` entry avoids
importing the libghostty SDK into a compatibility-only application. All xterm
public interfaces and types are exported, including `ITerminalOptions`, `ITheme`,
`ITerminalAddon`, `IBuffer`, `IBufferLine`, `IBufferCell`, `IParser`, `IMarker`,
`IDecoration`, `ILinkProvider`, `IUnicodeHandling`, `IModes` and `IEvent`.

The host must be visible and have dimensions before `open`, just as with xterm.
For Vite, use the asset adapter in your config:

```ts
import { wraith } from 'wraithterm/vite';
export default { plugins: [wraith()] };
```

## Keep existing imports unchanged

Install the supplied archive under the existing dependency key:

```json
{
  "dependencies": {
    "@xterm/xterm": "file:./wraithterm-0.2.0.tgz"
  }
}
```

Run `npm install`. Your application continues to use:

```ts
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
```

ES module imports and `require()` on Node 22.12+ are supported. Legacy script-tag
UMD bundles are not supplied.

The Vite config can import `wraith` from `@xterm/xterm/vite`. The official semantic
core is an internal npm alias, `@wraith-terminal/xterm-base`, so replacing the
`@xterm/xterm` dependency does not create a circular import. The package has not
been published to npm; the archive and local source are the available installs.

## Public surface

| Area                 | Supported API                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Construction and DOM | `new Terminal(options)`, `open`, `element`, `textarea`, `cols`, `rows`, mutable `options`, static `strings`, `dispose`                                                                                                                 |
| Output               | `write(string \| Uint8Array, callback?)`, `writeln`, `refresh`, `clear`, `reset`, `clearTextureAtlas`                                                                                                                                  |
| Input                | `focus`, `blur`, `input`, `paste`, `attachCustomKeyEventHandler`, `attachCustomWheelEventHandler`                                                                                                                                      |
| Buffers              | `buffer.active`, `.normal`, `.alternate`, `.onBufferChange`; cursor/base/viewport/length/type; `getLine`, `getNullCell`; line `length`, `isWrapped`, `getCell`, `translateToString`; every public cell color/style/width/code accessor |
| Scroll               | `scrollLines`, `scrollPages`, `scrollToTop`, `scrollToBottom`, `scrollToLine`                                                                                                                                                          |
| Selection            | `hasSelection`, `getSelection`, `getSelectionPosition`, `select`, `selectAll`, `selectLines`, `clearSelection`                                                                                                                         |
| Extension            | `loadAddon`, `registerLinkProvider`, character joiner registration/removal, `registerMarker`, `markers`, `registerDecoration`                                                                                                          |
| Parser               | CSI/OSC/DCS/ESC registration, handler ordering, disposable handlers, async CSI/OSC/DCS handlers                                                                                                                                        |
| Unicode and modes    | `unicode.register`, `.versions`, `.activeVersion`, complete `modes`                                                                                                                                                                    |
| Events               | `onBell`, `onBinary`, `onCursorMove`, `onData`, `onKey`, `onLineFeed`, `onRender`, `onWriteParsed`, `onResize`, `onScroll`, `onSelectionChange`, `onTitleChange`                                                                       |

All 6.0 public options are forwarded to upstream. Proposed API gates remain:
set `allowProposedApi: true` where the original API or addon requires it.
`write`, `writeln`, `open`, `resize` and `dispose` retain their synchronous **void**
return types. Parsing remains asynchronous; the write callback indicates when
buffer reads are current. The callback does not promise GPU completion.

## Rendering and fallback

`open()` initializes WebGPU asynchronously while the original DOM renderer is
usable. No application initialization changes are needed. Optional Wraith-only
diagnostics are available:

```ts
const available = await terminal.webgpuReady;
console.log(available, terminal.renderer, terminal.rendererFallbackReason);
```

The GPU renderer reads changed xterm rows directly, resolves colors/styles and
selection, and packs 20-byte cells directly into reusable Wasm staging memory, skipping or
moving rows whose raw xterm words are unchanged. Canvas2D
rasterizes CSS font glyphs only on cache misses; Rust owns texture uploads,
resident cell buffers and the shared two-draw WebGPU pipeline. Moved GPU rows
keep their physical slots; only new content and a small row map are uploaded.
Font options and
DPR changes update geometry and the atlas. There is no ANSI replay into Ghostty.

Transparency, minimum contrast adjustment, custom character joiners, buffer
color decorations, and link hover decoration currently use the retained xterm
DOM renderer. GPU rendering resumes when the feature is removed. Unsupported
WebGPU environments, device errors and atlas capacity errors also use DOM, with
a diagnostic reason. This preserves behavior while GPU coverage expands; it
means some options and decorated addons do not currently receive GPU acceleration.
Other renderer addons can replace Wraith through xterm's normal render service.

Full API compatibility is distinct from claiming pixel-identical rendering,
all terminal protocols, or every historical xterm version. Deprecated pre-6 APIs
are not added. Private integration is pinned to 6.0 and must be retested before
upgrading. Existing native-path performance results do not measure this profile;
xterm parsing, buffer reads and browser glyph rasterization have separate costs.

## Verification

`npm test` runs public API/type assignability, member coverage, defaults, write
callbacks, styles, split UTF-8, async parser hooks, modes, reflow/history, effects,
addon lifecycle and validation tests.

With the demo server running:

```sh
npm run test:xterm
npm run test:xterm-consumer
```

The Chrome suite compares cells, buffers, parser interception, selection,
serialization, modes and geometry with an official xterm 6.0 instance. It tests
original Fit 0.11.0, Search 0.16.0, Serialize 0.14.0, Attach 0.12.0 and Unicode11
0.9.0 addons, visual fallback/resumption, keyboard input and real GPU pixels.
The independent consumer test installs the packed library as `@xterm/xterm`,
typechecks unchanged imports with `skipLibCheck: false`, and verifies Vite dev and
production bundles. Recorded evidence is in
[compatibility/xterm-chrome.json](compatibility/xterm-chrome.json).

The compatibility playground is `/xterm.html`. Cross-browser certification and
real assistive-technology auditing remain release work.
