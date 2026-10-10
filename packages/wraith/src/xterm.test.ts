import { describe, expect, it } from 'vitest';
import { Terminal } from './xterm.js';
import { Terminal as OriginalTerminal, type Terminal as OriginalApi } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
const write = (term: OriginalApi, data: string | Uint8Array) =>
  new Promise<void>((r) => term.write(data, r));
const text = (term: OriginalApi) =>
  Array.from({ length: term.buffer.active.length }, (_, y) =>
    term.buffer.active.getLine(y)?.translateToString(true),
  ).join('\n');
describe('complete xterm 6.0 public API', () => {
  it('is assignable to the official Terminal API and preserves defaults', () => {
    const term: OriginalApi = new Terminal();
    const original = new OriginalTerminal();
    expect(Object.keys(term.options).sort()).toEqual(Object.keys(original.options).sort());
    expect(term.cols).toBe(original.cols);
    expect(term.rows).toBe(original.rows);
    expect(Terminal.strings).toEqual(OriginalTerminal.strings);
    term.dispose();
    original.dispose();
  });
  it('retains every public method/event/getter', () => {
    const original = new OriginalTerminal(),
      term = new Terminal();
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(original))) {
      if (key === 'constructor' || key.startsWith('_')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(original), key)!;
      if (descriptor.value)
        expect(typeof (term as unknown as Record<string, unknown>)[key], key).toBe(
          typeof descriptor.value,
        );
      else expect(key in term, key).toBe(true);
    }
    term.dispose();
    original.dispose();
  });
  it('keeps write void, callback ordering and exact buffer cell attributes', async () => {
    const term = new Terminal({ cols: 12, rows: 3 });
    const original = new OriginalTerminal({ cols: 12, rows: 3 });
    const input = '\x1b[1;3;4;38;2;11;22;33mAB界e\u0301\x1b[0m\r\nnext';
    expect(term.write('', () => {})).toBeUndefined();
    await Promise.all([write(term, input), write(original, input)]);
    expect(text(term)).toBe(text(original));
    for (let x = 0; x < 12; x++) {
      const a = term.buffer.active.getLine(0)!.getCell(x)!,
        b = original.buffer.active.getLine(0)!.getCell(x)!;
      expect([
        a.getChars(),
        a.getWidth(),
        a.getFgColor(),
        a.isBold(),
        a.isItalic(),
        a.isUnderline(),
      ]).toEqual([
        b.getChars(),
        b.getWidth(),
        b.getFgColor(),
        b.isBold(),
        b.isItalic(),
        b.isUnderline(),
      ]);
    }
    term.dispose();
    original.dispose();
  });
  it('parses fragmented UTF-8 Uint8Array writes', async () => {
    const term = new Terminal({ cols: 20, rows: 2 });
    const input = new TextEncoder().encode('A界🦀é');
    for (const byte of input) await write(term, Uint8Array.of(byte));
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('A界🦀é');
    term.dispose();
  });
  it('supports async CSI handlers and OSC/DCS/ESC handler disposal', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const seen: unknown[] = [];
    const subscriptions = [
      term.parser.registerCsiHandler({ prefix: '?', final: 'z' }, async (p) => {
        await Promise.resolve();
        seen.push(p);
        return true;
      }),
      term.parser.registerOscHandler(777, (d) => {
        seen.push(d);
        return true;
      }),
      term.parser.registerDcsHandler({ final: 'q' }, (d, p) => {
        seen.push([d, p]);
        return true;
      }),
      term.parser.registerEscHandler({ final: 'Z' }, () => {
        seen.push('esc');
        return true;
      }),
    ];
    await write(term, '\x1b[?3;4z\x1b]777;payload\x07\x1bP2qbody\x1b\\\x1bZdone');
    expect(seen).toEqual([[3, 4], 'payload', ['body', [2]], 'esc']);
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('done');
    subscriptions.forEach((s) => s.dispose());
    term.dispose();
  });
  it('preserves normal/alternate buffers, modes and buffer activation events', async () => {
    const term = new Terminal();
    const activated: string[] = [];
    term.buffer.onBufferChange((b) => activated.push(b.type));
    await write(term, 'normal\x1b[?1049hALT\x1b[?2004h\x1b[?1003h');
    expect(term.buffer.active.type).toBe('alternate');
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(term.modes.mouseTrackingMode).toBe('any');
    await write(term, '\x1b[?1049l');
    expect(term.buffer.active.type).toBe('normal');
    expect(term.buffer.normal.getLine(0)!.translateToString(true)).toBe('normal');
    expect(activated).toEqual(['alternate', 'normal']);
    term.dispose();
  });
  it('matches history, wrap/reflow, clear and reset', async () => {
    const options = { cols: 10, rows: 3, scrollback: 8, convertEol: true };
    const term = new Terminal(options),
      original = new OriginalTerminal(options);
    const input = 'abcdefghijklmn\n' + Array.from({ length: 14 }, (_, i) => `${i} row`).join('\n');
    await Promise.all([write(term, input), write(original, input)]);
    term.resize(7, 4);
    original.resize(7, 4);
    expect(text(term)).toBe(text(original));
    expect(term.buffer.active.length).toBe(original.buffer.active.length);
    term.clear();
    original.clear();
    expect(text(term)).toBe(text(original));
    term.reset();
    original.reset();
    expect(text(term)).toBe(text(original));
    term.dispose();
    original.dispose();
  });
  it('preserves event disposables, title/bell and input', async () => {
    const term = new Terminal();
    const events: string[] = [];
    const d = term.onData((data) => events.push(data));
    term.onTitleChange((title) => events.push(title));
    term.onBell(() => events.push('bell'));
    await write(term, '\x1b]2;title\x07\x07\x1b[?2004h');
    term.input('input', false);
    d.dispose();
    term.input('ignored');
    expect(events).toEqual(['title', 'bell', 'input']);
    term.dispose();
  });
  it('loads original Unicode and Serialize addons and disposes addons', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const unicode = new Unicode11Addon(),
      serialize = new SerializeAddon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = '11';
    term.loadAddon(serialize);
    let activated = false,
      disposed = false;
    term.loadAddon({
      activate(t) {
        activated = t === term;
      },
      dispose() {
        disposed = true;
      },
    });
    await write(term, '\x1b[31mred\x1b[0m\r\nsecond');
    expect(term.unicode.versions).toContain('11');
    expect(serialize.serialize()).toContain('red');
    expect(activated).toBe(true);
    term.dispose();
    expect(disposed).toBe(true);
  });
  it('matches upstream validation and proposed API gates', () => {
    const term = new Terminal();
    const original = new OriginalTerminal();
    expect(() => term.unicode).toThrow(/allowProposedApi/);
    expect(() => term.markers).toThrow(/allowProposedApi/);
    expect(() => term.resize(1.5, 2)).toThrow();
    expect(() => original.resize(1.5, 2)).toThrow();
    expect(() => {
      Reflect.set(term.options, 'cols', 99);
    }).toThrow();
    term.dispose();
    original.dispose();
  });
});
