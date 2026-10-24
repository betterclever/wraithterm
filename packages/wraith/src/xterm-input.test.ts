import { describe, expect, it } from 'vitest';
import { Terminal } from './xterm.js';
import { Terminal as OriginalTerminal, type Terminal as TerminalApi } from '@xterm/xterm';
import { Terminal as RuntimeTerminal } from '@wraith-terminal/xterm-base/lib/xterm.mjs';
import { accelerateInput } from './xterm-input.js';
import { installParameterBatching } from './xterm-parser.js';

const options = { cols: 64, rows: 6, scrollback: 0, allowProposedApi: true };
const write = (term: TerminalApi, data: string | Uint8Array) =>
  new Promise<void>((resolve) => term.write(data, resolve));
// Synchronous parsing is confined to tests without async handlers. Public
// write/continuation semantics are exercised separately below.
function input(term: TerminalApi) {
  return (
    term as unknown as {
      _core: {
        _inputHandler: {
          parse(data: string | Uint8Array): unknown;
          _extractColor: unknown;
          _curAttrData: unknown;
        };
      };
    }
  )._core._inputHandler;
}
function snapshot(term: TerminalApi) {
  const b = term.buffer.active;
  return {
    x: b.cursorX,
    y: b.cursorY,
    attributes: JSON.stringify(input(term)._curAttrData),
    lines: Array.from({ length: b.length }, (_, y) => {
      const line = b.getLine(y)!;
      return {
        wrapped: line.isWrapped,
        // Real upstream CellData includes combined text and extended attrs,
        // including underline color/style, protected cells and hyperlink ids.
        cells: Array.from({ length: line.length }, (_, x) => JSON.stringify(line.getCell(x))),
      };
    }),
  };
}
function pair() {
  const terminals = [new Terminal(options), new OriginalTerminal(options)] as const;
  return {
    terminals,
    parse(data: string | Uint8Array) {
      for (const term of terminals) expect(input(term).parse(data)).toBeUndefined();
    },
    equal() {
      expect(snapshot(terminals[0])).toEqual(snapshot(terminals[1]));
    },
    dispose() {
      terminals.forEach((t) => t.dispose());
    },
  };
}

describe('xterm input acceleration against the unmodified upstream runtime', () => {
  it('preserves interrupted CSI introducers, control bytes and parameter resets', () => {
    const p = pair();
    const sequences = [
      '\x1b[38;2;10;20;30mA',
      '\x1b[\x00;4H',
      '\x1b[?7lABC\x1b[?7h',
      '\x1b[4:3;58:2::1:2:3mB\x1b[0;38;5;9mC',
      '\x1b[1;2\x18D',
      '\x1b[1;2\x1b[31mE',
      '\x1b\x1b[32mF',
      '\x1b]2;title\x1b[33mG',
      '\x1bP$qm\x1b[34mH',
    ];
    try {
      for (const sequence of sequences) {
        // Splits before/after each introducer byte exercise both the fused and
        // ordinary transitions, then check cell and extended-attribute state.
        for (let split = 0; split <= sequence.length; split++) {
          p.terminals.forEach((term) => term.reset());
          p.parse(sequence.slice(0, split));
          p.equal();
          p.parse(sequence.slice(split));
          p.equal();
        }
      }
    } finally {
      p.dispose();
    }
  });

  it('does not install the fused parser over unfamiliar CSI transitions', () => {
    const Base: typeof TerminalApi = RuntimeTerminal;
    const term = new Base(options);
    const parser = (
      term as unknown as {
        _core: {
          _inputHandler: { _parser: { parse: unknown; _transitions: { table: Uint8Array } } };
        };
      }
    )._core._inputHandler._parser;
    const table = parser._transitions;
    const parse = parser.parse;
    try {
      // Replace only this instance's table; upstream owns the shared original.
      parser._transitions = { table: table.table.slice() };
      parser._transitions.table[0x15b] = 0;
      expect(installParameterBatching(term)).toBe(false);
      expect(parser.parse).toBe(parse);
    } finally {
      parser._transitions = table;
      term.dispose();
    }
  });

  it('preserves every box/block scalar, combining suffixes, wide-cell repair and row edges', () => {
    const p = pair();
    try {
      for (let code = 0x2500; code <= 0x259f; code++) {
        p.parse('\x1b[0m\x1b[2J\x1b[H界界界\x1b[1;2H');
        p.parse(String.fromCodePoint(code));
        p.parse('e\u0301');
        p.parse(`\x1b[1;64H${String.fromCodePoint(code)}\u0301X`);
        p.equal();
      }
    } finally {
      p.dispose();
    }
  });
  it('matches 2400 common style/color combinations and atomic fallback after a supported prefix', () => {
    const p = pair();
    const styles = [0, 1, 2, 3, 7, 8, 9];
    try {
      for (let n = 0; n < 2400; n++) {
        if (n % 60 === 0) p.parse('\x1b]8;;https://example.com\x1b\\\x1b[4:3;58:2::10:20:30m');
        if (n % 60 === 30) p.parse('\x1b]8;;\x1b\\');
        const color = n % 2 ? `2;${n};${n * 17};${n * 47}` : `5;${n}`;
        const sgr = `${styles[n % styles.length]};38;${color};48;${color};${styles[(n * 3) % styles.length]}`;
        p.parse(`\x1b[${sgr}mAB`);
        // Unsupported suffixes must observe the initial state, including when
        // the tentative fast path already encountered SGR0 or both colors.
        if (n % 11 === 0) p.parse(`\x1b[${sgr};4:5;58:5:123mC`);
        if (n % 24 === 0) p.equal();
      }
      p.equal();
    } finally {
      p.dispose();
    }
  });
  it('preserves colors, incomplete/mixed params, flags, hyperlinks and extended attributes', () => {
    const p = pair();
    try {
      const colors = [
        '',
        '2',
        '5',
        '2;1',
        '2;1;2',
        '2;1;2;3',
        '5;21',
        '5;256',
        '2;256;511;2147483647',
        '2;;;',
        '2;0;0;0;1',
        '5;42;7',
        '0;1;2;3',
        '3;1;2;3',
        '2:1:2:3',
        '2::1:2:3',
        '2:0:1:2:3',
        '5:21',
        '2;1:2;3;4',
        '2;1;2:3;4',
        '2;1;2;3:4',
      ];
      for (const target of [38, 48, 58]) {
        for (const separator of [';', ':']) {
          for (const color of colors) {
            p.parse(
              '\x1b[0;1;2;3;7;8;9;53;4:3;58:2::13:17:19m' +
                `\x1b[${target}${separator}${color}mA界é`,
            );
            p.equal();
          }
        }
      }
      p.parse('\x1b]8;id=same;https://example.com\x1b\\\x1b[38;2;1;2;3mURL');
      p.equal();
      p.parse('\x1b[48;2;4;5;6m\x1b[58;5;123m\x1b[0mnext\x1b]8;;\x1b\\');
      p.equal();
    } finally {
      p.dispose();
    }
  });

  it('matches 6000 deterministic random SGR sequences including parameter overflow', () => {
    const p = pair();
    let seed = 0x713ac;
    const random = (bound: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    const tokens = [
      '',
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '7',
      '8',
      '9',
      '21',
      '22',
      '23',
      '24',
      '25',
      '27',
      '28',
      '29',
      '31',
      '38',
      '39',
      '48',
      '49',
      '53',
      '55',
      '58',
      '59',
      '97',
      '107',
      '255',
      '256',
      '2147483647',
      '99999999999999999999999999999999',
    ];
    try {
      for (let n = 0; n < 6000; n++) {
        let data = '\x1b[';
        const count = 1 + random(48);
        for (let i = 0; i < count; i++) {
          if (i) data += random(5) ? ';' : ':';
          data += random(2) ? tokens[random(tokens.length)] : String(random(1024));
        }
        p.parse(data + 'mX');
        if (n % 24 === 0) p.equal();
      }
      p.equal();
    } finally {
      p.dispose();
    }
  });

  it('retains partial CSI/UTF-8 state at every byte boundary and through reset', async () => {
    const p = pair();
    try {
      const bytes = new TextEncoder().encode(
        '\x1b[1;38;2;255;127;0;48;5;21m界é🦀\x1b[4:3;58:2::1:2:3mB',
      );
      for (const byte of bytes) {
        await Promise.all(p.terminals.map((t) => write(t, Uint8Array.of(byte))));
        p.equal();
      }
      p.terminals.forEach((t) => t.reset());
      await Promise.all(p.terminals.map((t) => write(t, '\x1b[38;2;31;63;127mRESET')));
      p.equal();
    } finally {
      p.dispose();
    }
  });

  it('preserves async SGR interception, fallthrough, handler order and write callbacks', async () => {
    const p = pair();
    try {
      const observed: unknown[][] = [[], []];
      for (const [i, term] of p.terminals.entries()) {
        term.parser.registerCsiHandler({ final: 'm' }, (params) => {
          observed[i]!.push(['first', params]);
          return params[0] === 48;
        });
        term.parser.registerCsiHandler({ final: 'm' }, async (params) => {
          await Promise.resolve();
          observed[i]!.push(['last', params]);
          return false;
        });
      }
      await Promise.all(
        p.terminals.map(async (term, i) => {
          await write(term, '\x1b[38;2;10;20;30mA\x1b[48;5;99mB\x1b[38:2::4:5:6mC');
          observed[i]!.push('callback');
        }),
      );
      expect(observed[0]).toEqual(observed[1]);
      expect(observed[0]).toHaveLength(7);
      p.equal();
    } finally {
      p.dispose();
    }
  });

  it('does not patch upstream instances or prototypes and ignores unsupported internals', () => {
    const Base: typeof TerminalApi = RuntimeTerminal;
    const original = new Base(options);
    const method = input(original)._extractColor;
    const term = new Terminal(options);
    try {
      expect(input(original)._extractColor).toBe(method);
      expect(input(term)._extractColor).not.toBe(method);
      expect(() => accelerateInput({} as Terminal)).not.toThrow();
      expect(() => accelerateInput({ _core: {} } as unknown as Terminal)).not.toThrow();
      const unsupported = { _extractColor: method, _parser: { _params: { params: [] } } };
      accelerateInput({ _core: { _inputHandler: unsupported } } as unknown as Terminal);
      expect(unsupported._extractColor).toBe(method);
    } finally {
      term.dispose();
      original.dispose();
    }
  });
});
