import type { Terminal } from './xterm-api.js';

interface Provider {
  version: string;
  charProperties(code: number, preceding: number): number;
  wcwidth(code: number): number;
}
interface PrintInput {
  print(data: Uint32Array, start: number, end: number): void;
  _activeBuffer: {
    x: number;
    y: number;
    ybase: number;
    lines: { get(index: number): { _data?: Uint32Array } | undefined };
  };
  _curAttrData: { fg: number; bg: number };
  _bufferService: { cols: number };
  _charsetService: { charset: unknown };
  _coreService: { modes: { insertMode: boolean }; decPrivateModes: { wraparound: boolean } };
  _optionsService: { rawOptions: { screenReaderMode: boolean } };
  _unicodeService: { _activeProvider: Provider };
  _dirtyRowTracker: { markDirty(row: number): void };
  _parser: { precedingJoinState: number };
}

/** Fixed-width runs write xterm's pinned cell layout in row-sized chunks.
 * One upstream character at each wrap boundary retains scrolling and margin
 * behavior. Upstream handles Unicode, links/extended attributes, insert
 * mode, charset translation and accessibility. Capture the builtin provider at
 * construction: addons replacing even the same version must use upstream. */
export function installBulkPrint(terminal: Terminal): boolean {
  const input = (terminal as unknown as { _core?: { _inputHandler?: PrintInput } })._core
    ?._inputHandler;
  const provider = input?._unicodeService?._activeProvider;
  if (
    !input ||
    typeof input.print !== 'function' ||
    provider?.version !== '6' ||
    typeof provider.charProperties !== 'function' ||
    typeof provider.wcwidth !== 'function' ||
    !input._bufferService ||
    !input._charsetService ||
    !input._coreService?.modes ||
    typeof input._coreService.decPrivateModes?.wraparound !== 'boolean' ||
    !input._optionsService?.rawOptions ||
    !input._parser ||
    typeof input._dirtyRowTracker?.markDirty !== 'function'
  )
    return false;
  const original = input.print;
  const properties = provider.charProperties,
    width = provider.wcwidth;
  input.print = function (data, start, end) {
    const b = this._activeBuffer,
      attr = this._curAttrData;
    const cols = this._bufferService.cols;
    if (
      end === start ||
      (!this._coreService.decPrivateModes.wraparound && b.x + end - start > cols) ||
      this._charsetService.charset ||
      this._coreService.modes.insertMode ||
      this._optionsService.rawOptions.screenReaderMode ||
      attr.bg & 0x10000000 ||
      this._unicodeService._activeProvider !== provider ||
      provider.charProperties !== properties ||
      provider.wcwidth !== width
    )
      return original.call(this, data, start, end);
    // Unicode 6's builtin provider gives ASCII and box/block drawing width 1
    // with no joining state. This includes the single half-block runs used by
    // truecolor terminal graphics. Every other codepoint uses upstream.
    for (let i = start; i < end; i++) {
      const code = data[i]!;
      if (!((code >= 32 && code <= 126) || (code >= 0x2500 && code <= 0x259f)))
        return original.call(this, data, start, end);
    }
    // Keep the common non-wrapping path small: no row-loop bookkeeping or
    // second line lookup when the complete run already fits in this row.
    if (b.x + end - start <= cols) {
      const words = b.lines.get(b.ybase + b.y)?._data;
      if (!(words instanceof Uint32Array) || words.length !== cols * 3)
        return original.call(this, data, start, end);
      this._dirtyRowTracker.markDirty(b.y);
      if (b.x && words[(b.x - 1) * 3]! >>> 22 === 2) {
        const at = (b.x - 1) * 3;
        words[at] = 1 << 22;
        words[at + 1] = attr.fg;
        words[at + 2] = attr.bg;
      }
      for (let i = start, at = b.x * 3; i < end; i++, at += 3) {
        words[at] = data[i]! | (1 << 22);
        words[at + 1] = attr.fg;
        words[at + 2] = attr.bg;
      }
      b.x += end - start;
      this._parser.precedingJoinState = 2;
      if (b.x < cols && words[b.x * 3] === 0) {
        const at = b.x * 3;
        words[at] = 1 << 22;
        words[at + 1] = attr.fg;
        words[at + 2] = attr.bg;
      }
      this._dirtyRowTracker.markDirty(b.y);
      return;
    }
    this._dirtyRowTracker.markDirty(b.y);
    let position = start;
    let words: Uint32Array | undefined;
    while (position < end) {
      if (b.x >= cols) {
        // Let pinned upstream perform delayed autowrap, margins, scrolling,
        // scrollback events and isWrapped updates. Only one cell is generic.
        original.call(this, data, position, position + 1);
        position++;
        // Scroll listeners may change options/providers or resize. Stop using
        // captured geometry and state if the host changes them at a boundary.
        if (
          this._activeBuffer !== b ||
          this._bufferService.cols !== cols ||
          this._curAttrData !== attr ||
          this._charsetService.charset ||
          this._coreService.modes.insertMode ||
          !this._coreService.decPrivateModes.wraparound ||
          this._optionsService.rawOptions.screenReaderMode ||
          attr.bg & 0x10000000 ||
          this._unicodeService._activeProvider !== provider ||
          provider.charProperties !== properties ||
          provider.wcwidth !== width
        )
          return original.call(this, data, position, end);
        continue;
      }
      words = b.lines.get(b.ybase + b.y)?._data;
      if (!(words instanceof Uint32Array) || words.length !== cols * 3)
        return original.call(this, data, position, end);
      this._dirtyRowTracker.markDirty(b.y);
      // Repair the leading half when overwriting a wide-cell continuation.
      if (b.x && words[(b.x - 1) * 3]! >>> 22 === 2) {
        const at = (b.x - 1) * 3;
        words[at] = 1 << 22;
        words[at + 1] = attr.fg;
        words[at + 2] = attr.bg;
      }
      const count = Math.min(end - position, cols - b.x);
      const stop = position + count;
      for (let at = b.x * 3; position < stop; position++, at += 3) {
        words[at] = data[position]! | (1 << 22);
        words[at + 1] = attr.fg;
        words[at + 2] = attr.bg;
      }
      b.x += count;
    }
    this._parser.precedingJoinState = 2;
    words = b.lines.get(b.ybase + b.y)?._data;
    if (b.x < cols && words instanceof Uint32Array && words[b.x * 3] === 0) {
      const at = b.x * 3;
      words[at] = 1 << 22;
      words[at + 1] = attr.fg;
      words[at + 2] = attr.bg;
    }
    this._dirtyRowTracker.markDirty(b.y);
  };
  return true;
}
