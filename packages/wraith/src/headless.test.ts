import { beforeAll, describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import init, { Headless, type InitOutput } from '../wasm/wraith_engine.js';
import { KEY_CODES } from './keycodes.js';
let wasm: InitOutput;
const encode = (text: string) => new TextEncoder().encode(text);
beforeAll(async () => {
  wasm = await init({
    module_or_path: await readFile(new URL('../wasm/wraith_engine_bg.wasm', import.meta.url)),
  });
});
describe('the packaged Ghostty + Rust Wasm ABI', () => {
  it('retains the configured history across many allocated pages', () => {
    const core = new Headless(120, 40, 10000);
    try {
      core.write(
        encode(
          '\x1bc' +
            Array.from({ length: 9000 }, (_, i) => `line ${i} needle-${i} build\r\n`).join(''),
        ),
      );
      core.search('needle-100 build', 0);
      for (let i = 0; i < 1000; i++) if (core.search('', 1)[0] === 2) break;
      expect(core.search('', 2)[1]).toBe(1);
    } finally {
      core.free();
    }
  });
  it('exposes incremental Unicode-aware history search through the packaged Wasm ABI', () => {
    const core = new Headless(12, 3, 100);
    try {
      core.write(encode('old MATCH\r\n界 match\r\nnew MATCH\r\nend'));
      core.search('match', 0);
      for (let i = 0; i < 100; i++) {
        if (core.search('', 1)[0] === 2) break;
      }
      expect(Array.from(core.search('', 2))).toEqual([2, 3, 0]);
      expect(Array.from(core.search('', 2))).toEqual([2, 3, 1]);
      expect(Array.from(core.search('', 4))).toEqual([2, 0, 0xffffffff]);
    } finally {
      core.free();
    }
  });
  it('preserves UTF-8 and CSI state across one-byte writes', () => {
    const core = new Headless(80, 24, 100);
    try {
      for (const byte of encode('界é\x1b[38;2;1;2;3mX')) core.write(new Uint8Array([byte]));
      expect(core.text()).toBe('界éX');
      expect(core.cell(3, 0)[1]).toBe(1 | (2 << 8) | (3 << 16));
    } finally {
      core.free();
    }
  });
  it('encodes arrows from actual terminal modes', () => {
    const core = new Headless(80, 24, 100);
    try {
      core.key(KEY_CODES.ArrowUp!, 0, 1, '', 0);
      expect(new TextDecoder().decode(core.take_events()[0][1])).toBe('\x1b[A');
      core.write(encode('\x1b[?1h'));
      core.key(KEY_CODES.ArrowUp!, 0, 1, '', 0);
      expect(new TextDecoder().decode(core.take_events()[0][1])).toBe('\x1bOA');
    } finally {
      core.free();
    }
  });
  it('encodes Kitty disambiguation and reports protocol state', () => {
    const core = new Headless(80, 24, 100);
    try {
      core.write(encode('\x1b[>1u\x1b[?u'));
      core.key(KEY_CODES.KeyA!, 2, 1, 'a', 97);
      const data = core
        .take_events()
        .filter(([kind]) => kind === 0)
        .map(([, bytes]) => new TextDecoder().decode(bytes))
        .join('');
      expect(data).toContain('\x1b[?1u');
      expect(data).toContain('\x1b[97;5u');
    } finally {
      core.free();
    }
  });
  it('enforces cell bounds at the JavaScript boundary', () => {
    const core = new Headless(80, 24, 100);
    try {
      expect(() => core.cell(80, 0)).toThrow('bounds');
    } finally {
      core.free();
    }
  });
  it('reuses memory across repeated create/write/resize/free cycles', () => {
    const cycle = () => {
      const core = new Headless(80, 24, 1000);
      core.write(encode('hello\r\n'.repeat(200)));
      core.resize(100, 40);
      core.text();
      core.free();
    };
    for (let i = 0; i < 32; i++) cycle();
    const warm = wasm.memory.buffer.byteLength;
    for (let i = 0; i < 128; i++) cycle();
    expect(wasm.memory.buffer.byteLength).toBe(warm);
  });
});
