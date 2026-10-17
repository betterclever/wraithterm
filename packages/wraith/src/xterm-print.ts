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
  _coreService: { modes: { insertMode: boolean } };
  _optionsService: { rawOptions: { screenReaderMode: boolean } };
  _unicodeService: { _activeProvider: Provider };
  _dirtyRowTracker: { markDirty(row: number): void };
  _parser: { precedingJoinState: number };
}

/** A complete fixed-width run within one row can write xterm's pinned cell layout in
 * bulk. Upstream handles wrapping, Unicode, links/extended attributes, insert
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
      b.x + end - start > cols ||
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
    const words = b.lines.get(b.ybase + b.y)?._data;
    if (!(words instanceof Uint32Array) || words.length !== cols * 3)
      return original.call(this, data, start, end);
    this._dirtyRowTracker.markDirty(b.y);
    // Repair both halves when overwriting a wide cell, exactly as upstream.
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
  };
  return true;
}
