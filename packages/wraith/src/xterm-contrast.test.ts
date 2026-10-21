import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transpileModule, ModuleKind } from 'typescript';
import { describe, expect, it } from 'vitest';
import { adjustContrast, backgroundGlyph, ContrastCache } from './xterm-contrast.js';

// Execute the pinned upstream implementation as the oracle, rather than copying
// our own stepping algorithm into a test that could repeat the same mistake.
const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve('@xterm/xterm/src/common/Color.ts'), 'utf8');
const output = transpileModule(source, {
  compilerOptions: { module: ModuleKind.CommonJS },
}).outputText;
const exports: Record<string, any> = {};
new Function('exports', output)(exports);
const rgba = (bgr: number) =>
  (((bgr & 255) << 24) | ((bgr & 0xff00) << 8) | ((bgr >>> 16) << 8) | 255) >>> 0;
const bgr = (rgba: number) =>
  ((rgba >>> 24) | ((rgba >>> 8) & 0xff00) | ((rgba << 8) & 0xff0000)) >>> 0;

describe('GPU minimum contrast', () => {
  it('matches pinned xterm for deterministic colors, edge values and ratios', () => {
    let state = 123456789;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state & 0xffffff;
    };
    const pairs = [
      [0, 0],
      [0xffffff, 0xffffff],
      [0, 0xffffff],
      [0x7f7f7f, 0x808080],
      ...Array.from({ length: 2500 }, () => [random(), random()]),
    ];
    for (const [fg, bg] of pairs)
      for (const ratio of [1, 1.5, 2.25, 4.5, 7, 21]) {
        const expected = exports.rgba.ensureContrastRatio(rgba(bg!), rgba(fg!), ratio);
        expect(adjustContrast(fg!, bg!, ratio)).toBe(
          expected === undefined ? undefined : bgr(expected),
        );
      }
  });
  it('invalidates ratio changes, separates dim colors and bounds RGB churn', () => {
    const cache = new ContrastCache(8);
    cache.configure(7);
    expect(cache.resolve(0x777777, 0x888888, false)).toBe(adjustContrast(0x777777, 0x888888, 7));
    expect(cache.resolve(0x777777, 0x888888, true)).toBe(adjustContrast(0x777777, 0x888888, 3.5));
    for (let i = 0; i < 100; i++) {
      cache.resolve(i, i + 1, false);
      cache.resolve(i, i + 1, true);
    }
    expect(cache.size).toBeLessThanOrEqual(16);
    cache.configure(1);
    expect(cache.size).toBe(0);
    expect(cache.resolve(0x777777, 0x888888, false)).toBeUndefined();
  });
  it('excludes box drawing, blocks and Powerline background glyphs', () => {
    for (const code of [0x2500, 0x257f, 0x2580, 0x259f, 0xe0a4, 0xe0d6])
      expect(backgroundGlyph(code)).toBe(true);
    for (const code of [65, 0x24ff, 0x25a0, 0xe0a3, 0xe0d7, 0x1f642])
      expect(backgroundGlyph(code)).toBe(false);
  });
});
