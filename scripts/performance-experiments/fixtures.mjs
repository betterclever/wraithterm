// Shared by Node and Chrome; compare research actions with upstream semantics.
export async function inputFixtures(Terminal, OriginalTerminal, install) {
  const options = { cols: 37, rows: 8, scrollback: 24, allowProposedApi: true };
  const a = new Terminal(options),
    b = new OriginalTerminal(options);
  install(a);
  const input = (t) => t._core._inputHandler;
  const defaultProviders = [a, b].map((t) => input(t)._unicodeService._activeProvider);
  const snapshot = (t) => {
    const buffer = t.buffer.active,
      p = input(t)._parser;
    return JSON.stringify({
      buffer: buffer.type,
      x: buffer.cursorX,
      y: buffer.cursorY,
      base: buffer.baseY,
      viewport: buffer.viewportY,
      attrs: input(t)._curAttrData,
      parser: [p.currentState, p._collect, p.precedingJoinState, p._params.toArray()],
      lines: Array.from({ length: buffer.length }, (_, y) => {
        const row = buffer.getLine(y);
        return [row.isWrapped, Array.from({ length: row.length }, (_, x) => row.getCell(x))];
      }),
    });
  };
  let comparisons = 0,
    fragments = 0;
  const equal = (label) => {
    const left = snapshot(a),
      right = snapshot(b);
    if (left !== right) {
      let index = 0;
      while (left[index] === right[index]) index++;
      throw new Error(
        `${label}: first state difference at ${index}: ${left.slice(index, index + 160)} != ${right.slice(index, index + 160)}`,
      );
    }
    comparisons++;
  };
  const parse = (data) => {
    for (const t of [a, b]) {
      const result = input(t).parse(data);
      if (result?.then) throw new Error('Unexpected async handler in synchronous fixture');
    }
    fragments++;
  };
  const write = (t, data) => new Promise((resolve) => t.write(data, resolve));
  try {
    const atoms = [
      'ASCII run with spaces',
      '界🦀éä',
      '\r\n',
      '\b\t',
      '\x1b[H',
      '\x1b[2J',
      '\x1b[4:3;58:2::255:0:0m',
      '\x1b[38;2;255;127;0;48;5;21m',
      '\x1b[0m',
      '\x1b[2;4H',
      '\x1b[7;4H',
      '\x1b[31;44m',
      '\x1b[?7l',
      '\x1b[?7h',
      '\x1b[4h',
      '\x1b[4l',
      '\x1b[3;7r',
      '\x1b[r',
      '\x1b[L',
      '\x1b[M',
      '\x1b[2P',
      '\x1b[3@',
      '\x1b[4X',
      '\x1b[K',
      '\x1b[S',
      '\x1b[T',
      '\x1b[?1049h',
      '\x1b[?1049l',
      '\x1b7',
      '\x1b8',
      '\x1bM',
      '\x1b(0lqqk\x1b(B',
      '\x1b]8;;https://example.com\x1b\\URL ASCII\x1b]8;;\x1b\\',
      '\x1b[1;3;7;9;53mASCII styles',
      '\x1b[0;1;38;2;999;2147483647;0m',
      '\x1b[1;2;3\x18cancel',
      '\x1b[1;2\x1b[0m',
      '\x1b[1\x00;3m',
      '\x1b[?;1:2m',
      '\x1b[1;;:;2m',
      '\x1b[;;;;m',
      '\x1b[99999999999999999999999m',
      '\x1b[' + '1;'.repeat(70) + '38;2;1;2;3m',
      '\x1b[4:' + ':'.repeat(70) + '3m',
      '\x1bP$qm\x1b\\',
      '\x1b]2;title\x07',
      '\x1b[2 q',
      '\x1b[?6h',
      '\x1b[?6l',
    ];
    let seed = 0x2147;
    const random = (n) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let n = 0; n < 2500; n++) {
      let data = atoms[random(atoms.length)];
      if (n % 3 === 0)
        data = `\x1b[${Array.from({ length: 1 + random(50) }, () => String(random(4096))).join(random(3) ? ';' : ':')}m${data}`;
      // Exercise streaming across arbitrary UTF-8 and CSI boundaries.
      const bytes = new TextEncoder().encode(data);
      let at = 0;
      while (at < bytes.length) {
        const end = Math.min(bytes.length, at + 1 + random(17));
        parse(bytes.subarray(at, end));
        at = end;
      }
      if (n % 10 === 0) equal(`seeded stream ${n}`);
    }
    equal('seeded final');
    for (const text of [
      '\x1b[4:3;58:2::1:2:3mA',
      '\x1b[38;2;31;63;127m界é🦀',
      '\x1b[1;2;3;4:5;38;2;2147483647;0;255m',
    ]) {
      for (const t of [a, b]) t.reset();
      for (const byte of new TextEncoder().encode(text)) {
        parse(Uint8Array.of(byte));
        equal('single-byte CSI/UTF-8');
      }
    }
    for (const t of [a, b]) {
      t.reset();
      t.options.screenReaderMode = true;
    }
    const a11y = [[], []];
    for (const [i, t] of [a, b].entries()) input(t)._onA11yChar.event((char) => a11y[i].push(char));
    parse('accessibility ASCII with spaces');
    equal('accessibility');
    if (JSON.stringify(a11y[0]) !== JSON.stringify(a11y[1]))
      throw new Error('Accessibility events differ');
    for (const t of [a, b]) {
      t.options.screenReaderMode = false;
      t.reset();
    }
    // A custom provider with version 6 must not be mistaken for the builtin.
    for (const t of [a, b]) {
      t.unicode.register({ version: '6', wcwidth: () => 2, charProperties: () => 4 });
      t.unicode.activeVersion = '6';
    }
    parse('CUSTOM width provider');
    equal('custom Unicode provider');
    for (const [i, t] of [a, b].entries()) {
      t.unicode.register(defaultProviders[i]);
      t.unicode.activeVersion = '6';
      t.reset();
    }
    const events = [[], []];
    for (const [i, t] of [a, b].entries()) {
      t.parser.registerCsiHandler({ final: 'm' }, async (params) => {
        await Promise.resolve();
        events[i].push(['CSI', params]);
        return false;
      });
      t.parser.registerOscHandler(2, async (text) => {
        await Promise.resolve();
        events[i].push(['OSC', text]);
        return false;
      });
      t.parser.registerDcsHandler({ final: 'z' }, async (text, params) => {
        await Promise.resolve();
        events[i].push(['DCS', text, params]);
        return false;
      });
      t.parser.registerEscHandler({ final: '7' }, async () => {
        await Promise.resolve();
        events[i].push(['ESC']);
        return false;
      });
    }
    const asyncData =
      '\x1b[0mFAST PREFIX\x1b]2;async title\x07\x1b[38;2;1;2;3mNEXT\x1bP1;2zpayload\x1b\\\x1b7\x1b[48;5;42mFINAL';
    await Promise.all(
      [a, b].map(async (t, i) => {
        await write(t, asyncData);
        events[i].push('callback');
      }),
    );
    equal('mixed async continuation');
    if (JSON.stringify(events[0]) !== JSON.stringify(events[1]))
      throw new Error('Async handler order/parameters differ');
    for (const t of [a, b])
      t.parser.registerCsiHandler({ final: 'J' }, async () => {
        await Promise.resolve();
        t.reset();
        return true;
      });
    await Promise.all([a, b].map((t) => write(t, 'before\x1b[2Jafter\x1b[38;2;1;2;3mDONE')));
    equal('reset during async continuation');
    await Promise.all(
      [a, b].map((t) => write(t, '\x1b[38;2;1;2;3m' + 'large chunk ASCII '.repeat(18000))),
    );
    equal('large decoded chunk continuation');
    return {
      comparisons,
      fragments,
      randomAtoms: 2500,
      asyncEvents: events[0].length,
      checks: [
        'full buffer/attributes/parser state',
        'random malformed CSI',
        'overflow/subparameters',
        'UTF-8 fragmentation',
        'wrapping and wide-cell repair',
        'margins/insert/delete/alternate screen',
        'charset/hyperlinks',
        'accessibility events',
        'custom Unicode provider',
        'CSI/OSC/DCS/ESC async continuation',
      ],
    };
  } finally {
    a.dispose();
    b.dispose();
  }
}
