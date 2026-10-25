import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import init, { Headless } from '../wasm/wraith_engine.js';
import { parseOsc133 } from './osc133.js';
import { SHELL_INTEGRATION, promptKeyDirection } from './command-types.js';
import { Terminal, CommandBlocksAddon } from './xterm.js';

const encode = (text: string) => new TextEncoder().encode(text);
/** A synthetic shell session: two commands (one failing), then a prompt. */
const SESSION =
  '\x1b]133;A\x07$ \x1b]133;B\x07echo hi\r\n\x1b]133;C;cmdline_url=echo%20hi\x07' +
  'hi\r\nthere 界\r\n\x1b]133;D;0\x07' +
  '\x1b]133;A\x07$ \x1b]133;B\x07false\r\n\x1b]133;C\x1b\\\x1b]133;D;1\x1b\\' +
  '\x1b]133;A\x07$ ';

beforeAll(async () => {
  await init({
    module_or_path: await readFile(new URL('../wasm/wraith_engine_bg.wasm', import.meta.url)),
  });
});

describe('OSC 133 parsing', () => {
  it('decodes every step libghostty-vt reports', () => {
    expect(parseOsc133('A')).toEqual({ kind: 'prompt', prompt: 'primary' });
    expect(parseOsc133('A;k=s')).toEqual({ kind: 'prompt', prompt: 'secondary' });
    expect(parseOsc133('P;k=r')).toEqual({ kind: 'prompt', prompt: 'right' });
    expect(parseOsc133('B')).toEqual({ kind: 'input' });
    expect(parseOsc133('C')).toEqual({ kind: 'output', command: '' });
    expect(parseOsc133('C;cmdline_url=ls%20-la%20%E7%95%8C')).toEqual({
      kind: 'output',
      command: 'ls -la 界',
    });
    expect(parseOsc133("C;cmdline=$'echo a\\nb'")).toEqual({
      kind: 'output',
      command: 'echo a\nb',
    });
    expect(parseOsc133("C;cmdline='git status'")).toEqual({
      kind: 'output',
      command: 'git status',
    });
    expect(parseOsc133('D;0')).toEqual({ kind: 'end', exitCode: 0 });
    expect(parseOsc133('D;130;err=interrupted')).toEqual({ kind: 'end', exitCode: 130 });
    expect(parseOsc133('D')).toEqual({ kind: 'end', exitCode: undefined });
    expect(parseOsc133('L')).toBeUndefined();
  });
  it('binds Cmd+Up/Down on macOS and Ctrl+Shift+Up/Down elsewhere', () => {
    const key = (init: Partial<KeyboardEvent>) =>
      ({ type: 'keydown', altKey: false, ...init }) as KeyboardEvent;
    const mac = /Mac/.test(globalThis.navigator?.platform ?? '');
    const up = mac
      ? key({ key: 'ArrowUp', metaKey: true, ctrlKey: false, shiftKey: false })
      : key({ key: 'ArrowUp', metaKey: false, ctrlKey: true, shiftKey: true });
    expect(promptKeyDirection(up)).toBe(-1);
    expect(promptKeyDirection({ ...up, key: 'ArrowDown' } as KeyboardEvent)).toBe(1);
    expect(promptKeyDirection({ ...up, key: 'ArrowLeft' } as KeyboardEvent)).toBe(0);
    expect(promptKeyDirection({ ...up, type: 'keyup' } as KeyboardEvent)).toBe(0);
  });
  it('ships shell integration that emits every mark', () => {
    for (const snippet of Object.values(SHELL_INTEGRATION)) {
      for (const mark of ['133;A', '133;B', '133;C;cmdline_url=', '133;D;']) {
        expect(snippet).toContain(mark);
      }
    }
  });
});

type Raw = [number, number, number | null, string, number, number, number, number, boolean];
describe('native engine command blocks (packaged Wasm)', () => {
  const blocks = (core: Headless) => core.commands() as Raw[];
  it('records commands, exit codes and output', () => {
    const core = new Headless(40, 10, 100);
    try {
      expect(core.has_commands).toBe(false);
      core.write(encode(SESSION));
      const list = blocks(core);
      expect(list.map((b) => [b[0], b[1], b[2], b[3]])).toEqual([
        [1, 3, 0, 'echo hi'],
        [2, 3, 1, ''],
        [3, 0, null, ''],
      ]);
      expect(list[0]!.slice(4, 8)).toEqual([0, 0, 1, 3]);
      expect(core.command_text(1, false)).toEqual(['hi\nthere 界', false]);
      expect(core.command_text(2, true)).toEqual(['false', false]);
      expect(core.command_text(2, false)).toEqual(['', false]);
      expect(core.command_text(99, false)).toBeUndefined();
      const events = (core.take_events() as [number, Uint8Array][]).filter(([k]) => k === 5);
      expect(events.map(([, bytes]) => bytes[0])).toEqual([0, 2, 3, 0, 2, 3, 0]);
    } finally {
      core.free();
    }
  });
  it('parses identically at every chunk boundary', () => {
    const bytes = encode(SESSION);
    const whole = new Headless(40, 10, 100);
    whole.write(bytes);
    const expected = blocks(whole);
    const output = whole.command_text(1, false);
    whole.free();
    for (let split = 0; split <= bytes.length; split++) {
      const core = new Headless(40, 10, 100);
      core.write(bytes.subarray(0, split));
      core.write(bytes.subarray(split));
      expect(blocks(core), `split ${split}`).toEqual(expected);
      expect(core.command_text(1, false)).toEqual(output);
      core.free();
    }
    // Three-way splits around every OSC terminator.
    for (let a = 0; a < bytes.length; a += 7)
      for (let b = a; b <= bytes.length; b += 5) {
        const core = new Headless(40, 10, 100);
        core.write(bytes.subarray(0, a));
        core.write(bytes.subarray(a, b));
        core.write(bytes.subarray(b));
        expect(blocks(core)).toEqual(expected);
        core.free();
      }
  });
  it('follows reflow and reports trimmed blocks as truncated', () => {
    const core = new Headless(20, 6, 100);
    try {
      core.write(encode('\x1b]133;A\x07$ \x1b]133;B\x07cat\r\n\x1b]133;C\x07'));
      core.write(encode('abcdefghijklmnopqrstuvwxyz0123\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ '));
      core.resize(10, 6);
      expect(blocks(core)[0]!.slice(4, 8)).toEqual([0, 0, 1, 4]);
      expect(core.command_text(1, false)).toEqual(['abcdefghijklmnopqrstuvwxyz0123', false]);
      let lines = 0;
      while (blocks(core)[0]![4] !== -1 && lines < 200_000) {
        core.write(encode(Array.from({ length: 500 }, (_, i) => `x${lines + i}\r\n`).join('')));
        lines += 500;
      }
      const [first] = blocks(core);
      expect(first![8]).toBe(true);
      expect(first![2]).toBe(0);
      expect(core.command_text(1, false)).toEqual(['', true]);
    } finally {
      core.free();
    }
  });
  it('jumps between prompts', () => {
    const core = new Headless(20, 4, 100);
    try {
      for (let i = 0; i < 3; i++) {
        core.write(encode(`\x1b]133;A\x07$ \x1b]133;B\x07cmd${i}\r\n\x1b]133;C\x07`));
        for (let j = 0; j < 5; j++) core.write(encode(`out ${i}.${j}\r\n`));
        core.write(encode('\x1b]133;D;0\x07'));
      }
      core.write(encode('\x1b]133;A\x07$ '));
      expect(core.screen()[1]).toBe(15);
      expect([core.jump_to_prompt(-1), core.jump_to_prompt(-1)]).toEqual([12, 6]);
      expect(core.command_marks()[0]).toBe(2);
      expect(core.jump_to_prompt(1)).toBe(12);
      expect(core.jump_to_prompt(1)).toBe(15);
      expect(core.jump_to_prompt(1)).toBe(-1);
    } finally {
      core.free();
    }
  });
});

describe('xterm-compatible CommandBlocksAddon', () => {
  const write = (term: Terminal, data: string) => new Promise<void>((r) => term.write(data, r));
  const summary = async (addon: CommandBlocksAddon) =>
    Promise.all(
      (await addon.commands()).map(async (b) => ({
        id: b.id,
        command: b.command,
        state: b.state,
        exitCode: b.exitCode,
        rows: b.rows,
        output: await b.output(),
      })),
    );
  it('records the same blocks at every chunk boundary', async () => {
    const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    const addon = new CommandBlocksAddon();
    term.loadAddon(addon);
    await write(term, SESSION);
    const expected = await summary(addon);
    expect(expected.map((b) => [b.command, b.exitCode, b.output])).toEqual([
      ['echo hi', 0, 'hi\nthere 界'],
      ['false', 1, ''],
    ]);
    expect(expected[0]!.rows).toEqual({ prompt: 0, input: 0, output: 1, end: 3 });
    term.dispose();
    for (let split = 0; split <= SESSION.length; split++) {
      const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
      const addon = new CommandBlocksAddon();
      term.loadAddon(addon);
      await write(term, SESSION.slice(0, split));
      await write(term, SESSION.slice(split));
      expect(await summary(addon), `split ${split}`).toEqual(expected);
      term.dispose();
    }
  });
  it('fires onCommand, jumps to prompts and reports trimming', async () => {
    const term = new Terminal({ cols: 20, rows: 4, scrollback: 30, allowProposedApi: true });
    const addon = new CommandBlocksAddon();
    term.loadAddon(addon);
    const finished: number[] = [];
    addon.onCommand((b) => finished.push(b.exitCode ?? -1));
    for (let i = 0; i < 3; i++) {
      let chunk = `\x1b]133;A\x07$ \x1b]133;B\x07cmd${i}\r\n\x1b]133;C\x07`;
      for (let j = 0; j < 5; j++) chunk += `out ${i}.${j}\r\n`;
      await write(term, chunk + `\x1b]133;D;${i}\x07`);
    }
    await write(term, '\x1b]133;A\x07$ ');
    expect(finished).toEqual([0, 1, 2]);
    expect(term.buffer.active.viewportY).toBe(15);
    expect(addon.jumpToPrompt(-1)).toBe(true);
    expect(term.buffer.active.viewportY).toBe(12);
    expect(addon.jumpToPrompt(-1)).toBe(true);
    expect(term.buffer.active.viewportY).toBe(6);
    expect(addon.jumpToPrompt(1)).toBe(true);
    expect(term.buffer.active.viewportY).toBe(12);
    expect(addon.jumpToPrompt(1)).toBe(true);
    expect(term.buffer.active.viewportY).toBe(15);
    expect(addon.jumpToPrompt(1)).toBe(false);
    await write(term, Array.from({ length: 40 }, (_, i) => `fill ${i}\r\n`).join(''));
    const [first] = await addon.commands();
    expect(first!.truncated).toBe(true);
    expect(first!.rows.prompt).toBe(-1);
    term.dispose();
  });
});
