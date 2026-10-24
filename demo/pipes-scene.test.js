import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { createPipesScene, rasterizePipes, encodePipeFrame, PIPE_PRESETS } from './pipes-scene.js';

const options = { cols: 48, rows: 20, pipes: 8, length: 10, seed: 95 };
describe('terminal 3D pipes', () => {
  it('reproduces geometry and every pixel from the seed, with finite bounded mesh data', () => {
    const a = createPipesScene(options),
      b = createPipesScene(options);
    expect(a.stats).toEqual(b.stats);
    expect(a.positions).toEqual(b.positions);
    expect([...a.positions, ...a.normals].every(Number.isFinite)).toBe(true);
    expect(Math.max(...a.indices)).toBeLessThan(a.positions.length / 3);
    const image = rasterizePipes(a, 2);
    expect(image.pixels).toEqual(rasterizePipes(b, 2).pixels);
    expect(image.fragments).toBeGreaterThan(100);
    expect(new Set(image.pixels).size).toBeGreaterThan(100);
    expect(image.pixels).not.toEqual(rasterizePipes(a, 3).pixels);
    expect(a.positions).not.toEqual(createPipesScene({ ...options, seed: 96 }).positions);
  });

  it('round-trips both ANSI encodings to exact foreground/background pixels without scrolling', () => {
    const scene = createPipesScene(options);
    const term = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 0,
      allowProposedApi: true,
    });
    try {
      // Start with arbitrary style state. A complete frame must reset all attributes.
      term._core._inputHandler.parse('\x1b[1;3;4;7;9m');
      for (const time of [0, 2, 0]) {
        const image = rasterizePipes(scene, time);
        const stress = encodePipeFrame(image),
          compact = encodePipeFrame(image, { traffic: 'compact' });
        expect(stress.sgrChanges).toBe(options.cols * options.rows + 2);
        expect(compact.bytes.length).toBeLessThan(stress.bytes.length);
        for (const frame of [stress, compact]) {
          term._core._inputHandler.parse(frame.bytes);
          const buffer = term.buffer.active;
          expect(buffer.length).toBe(options.rows);
          expect(buffer.baseY).toBe(0);
          expect([buffer.cursorX, buffer.cursorY]).toEqual([0, 0]);
          for (let y = 0; y < options.rows; y++)
            for (let x = 0; x < options.cols; x++) {
              const cell = buffer.getLine(y).getCell(x);
              expect(cell.getChars()).toBe('▀');
              expect(cell.getFgColor()).toBe(image.pixels[y * 2 * options.cols + x]);
              expect(cell.getBgColor()).toBe(image.pixels[(y * 2 + 1) * options.cols + x]);
              expect(
                cell.isBold() || cell.isItalic() || cell.isUnderline() || cell.isInverse(),
              ).toBeFalsy();
            }
        }
      }
    } finally {
      term.dispose();
    }
  });

  it('depth testing makes overlapping pipe draw order irrelevant', () => {
    const scene = createPipesScene(options);
    const forward = rasterizePipes(scene, 1).pixels;
    const backward = rasterizePipes({ ...scene, groups: [...scene.groups].reverse() }, 1).pixels;
    expect(backward).toEqual(forward);
  });

  it('quantizes the entire image in 12-bit mode, including stars and background', () => {
    const image = rasterizePipes(createPipesScene(options), -1, { colors: 'rgb444' });
    expect(
      image.pixels.every((v) => [v >>> 16, (v >>> 8) & 255, v & 255].every((c) => c % 17 === 0)),
    ).toBe(true);
  });

  it('bounds custom geometry and rejects malformed inputs before allocating', () => {
    for (const override of [
      { cols: 321 },
      { rows: 0 },
      { pipes: Infinity },
      { length: 41 },
      { sides: 1 },
      { seed: -1 },
    ])
      expect(() => createPipesScene(override)).toThrow(RangeError);
    expect(() => rasterizePipes(createPipesScene(options), NaN)).toThrow(RangeError);
    expect(() => encodePipeFrame({ width: 3, height: 3, pixels: new Uint32Array(9) })).toThrow(
      RangeError,
    );
    expect(PIPE_PRESETS.inferno.cols * PIPE_PRESETS.inferno.rows).toBe(19200);
  });
});
