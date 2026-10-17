// Research helpers share the pinned parser generator with the SDK build.
import { generateParser } from '../generate-xterm-parser.mjs';
export async function parameterPrototype(root) {
  const generated = await generateParser(root);
  return {
    ...generated,
    code: generated.code.replace(
      'export function installParameterBatching',
      'export function install',
    ),
  };
}

/** Bulk store only a complete ordinary ASCII run that fits on its current row.
 * Unicode providers, wrapping, extended attrs, insert mode, accessibility and
 * charset translation continue through the unchanged upstream print action. */
export function bulkPrint(terminal) {
  const input = terminal._core._inputHandler;
  const original = input.print;
  const unicode = input._unicodeService;
  const provider = unicode._activeProvider;
  const properties = provider.charProperties;
  const width = provider.wcwidth;
  input.print = function (data, start, end) {
    const b = this._activeBuffer,
      attr = this._curAttrData;
    const cols = this._bufferService.cols;
    if (
      end - start < 4 ||
      b.x + end - start > cols ||
      this._charsetService.charset ||
      this._coreService.modes.insertMode ||
      this._optionsService.rawOptions.screenReaderMode ||
      attr.bg & 0x10000000 ||
      this._unicodeService._activeProvider !== provider ||
      provider.charProperties !== properties ||
      provider.wcwidth !== width
    ) {
      return original.call(this, data, start, end);
    }
    for (let i = start; i < end; i++)
      if (data[i] < 32 || data[i] > 126) return original.call(this, data, start, end);
    const row = b.lines.get(b.ybase + b.y);
    const words = row?._data;
    if (!(words instanceof Uint32Array) || words.length !== cols * 3)
      return original.call(this, data, start, end);
    this._dirtyRowTracker.markDirty(b.y);
    if (b.x && words[(b.x - 1) * 3] >>> 22 === 2) {
      const at = (b.x - 1) * 3;
      words[at] = 1 << 22;
      words[at + 1] = attr.fg;
      words[at + 2] = attr.bg;
    }
    for (let i = start, at = b.x * 3; i < end; i++, at += 3) {
      words[at] = data[i] | (1 << 22);
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
}
