// Research prototypes only. The production Terminal does not install these.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';

/** Keep xterm's dispatcher/continuation intact while batching ordinary params.
 * This prototype is generated from the installed, pinned MIT-licensed source.
 * It must pass differential tests before its timings are considered. */
export async function parameterPrototype(root) {
  const source = await readFile(
    `${root}/node_modules/@wraith-terminal/xterm-base/src/common/parser/EscapeSequenceParser.ts`,
    'utf8',
  );
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (sha256 !== 'c50c159ec6fb209a1be4f1fb4266c84865e4460d8b82f54e3d429b760386e4ef')
    throw new Error('Revalidate the research parser before changing pinned xterm source');
  const start = source.indexOf('  public parse(data: Uint32Array');
  if (start < 0) throw new Error('Unfamiliar xterm parser source');
  let method = source
    .slice(start, source.lastIndexOf('\n}'))
    .replace('  public parse(data:', 'function fastParse(this: any, data:');
  const a = method.indexOf('        case ParserAction.PARAM:');
  const b = method.indexOf('        case ParserAction.COLLECT:', a);
  if (a < 0 || b < 0) throw new Error('Unfamiliar xterm parameter action');
  method =
    method.slice(0, a) +
    `        case ParserAction.PARAM: {
          const p = this._params;
          // A colon at the first position must enter the upstream subparam path.
          if (code !== 0x3a && !p._digitIsSub && !p._rejectDigits && p.length) {
            const store = p.params;
            let index = p.length - 1;
            let value = store[index];
            do {
              if (code === 0x3b) {
                store[index] = value;
                p.addParam(0);
                if (p._rejectDigits) break;
                index++;
                value = 0;
              } else {
                value = value * 10 + code - 48;
                if (value > 0x7fffffff) value = 0x7fffffff;
              }
            } while (++i < length && (code = data[i]) > 0x2f && code < 0x3c && code !== 0x3a);
            store[index] = value;
            if (i === length || code < 0x30 || code > 0x3b) { i--; break; }
          }
          do {
            switch (code) {
              case 0x3b: p.addParam(0); break;
              case 0x3a: p.addSubParam(-1); break;
              default: p.addDigit(code - 48);
            }
          } while (++i < length && (code = data[i]) > 0x2f && code < 0x3c);
          i--;
          break;
        }
` +
    method.slice(b);
  const constants = `const enum TableAccess { TRANSITION_ACTION_SHIFT = 4, TRANSITION_STATE_MASK = 15, INDEX_STATE_SHIFT = 8 }
const enum ParserState { GROUND = 0, ESCAPE = 1 }
const enum ParserStackType { NONE, FAIL, RESET, CSI, ESC, OSC, DCS }
const enum ParserAction { IGNORE, ERROR, PRINT, EXECUTE, OSC_START, OSC_PUT, OSC_END, CSI_DISPATCH, PARAM, COLLECT, ESC_DISPATCH, CLEAR, DCS_HOOK, DCS_PUT, DCS_UNHOOK }
const NON_ASCII_PRINTABLE = 0xa0;
export function install(terminal: any) { terminal._core._inputHandler._parser.parse = fastParse; }
`;
  const compiled = ts.transpileModule(constants + method, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return {
    sourceSha256: sha256,
    code: `/** Copyright (c) 2017 The xterm.js authors. All rights reserved. @license MIT\n * Research derivative of EscapeSequenceParser.ts (${sha256}). */\n${compiled}`,
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
