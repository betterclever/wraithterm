import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';

/** Keep xterm's dispatcher/continuation intact while batching ordinary params.
 * This specialization is generated from the installed, pinned MIT-licensed source.
 * It must pass differential tests before its timings are considered. */
export async function generateParser(root) {
  const source = await readFile(
    `${root}/node_modules/@wraith-terminal/xterm-base/src/common/parser/EscapeSequenceParser.ts`,
    'utf8',
  );
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (sha256 !== 'c50c159ec6fb209a1be4f1fb4266c84865e4460d8b82f54e3d429b760386e4ef')
    throw new Error('Revalidate the parser before changing pinned xterm source');
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
export function installParameterBatching(terminal: any): boolean {
  const parser = terminal?._core?._inputHandler?._parser;
  const p = parser?._params;
  if (typeof parser?.parse !== 'function' || !(p?.params instanceof Int32Array) ||
      typeof p.addParam !== 'function' || typeof p.addSubParam !== 'function' ||
      typeof p.addDigit !== 'function' || typeof p._digitIsSub !== 'boolean' ||
      typeof p._rejectDigits !== 'boolean' || !parser._parseStack ||
      !(parser._transitions?.table instanceof Uint8Array)) return false;
  parser.parse = fastParse;
  return true;
}
`;
  const compiled = ts.transpileModule(constants + method, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return {
    sourceSha256: sha256,
    code: `/** Copyright (c) 2018 The xterm.js authors. All rights reserved. @license MIT\n * Generated derivative of EscapeSequenceParser.ts (${sha256}). */\n${compiled}`,
  };
}
