import { describe, expect, it } from 'vitest';
import { createPipeGrowth } from './pipes-growth.js';
import { preparePipePath, growingPipeMesh, rasterizePipes } from './pipes-scene.js';

const options = { cols: 72, rows: 32, pipes: 1, seed: 95, sides: 10 };
const view = { camera: 'fixed', framing: 'lattice', backdrop: 'black' };
describe('XP pipe growth', () => {
  it('extends a single sealed pipe, holds, clears completely, and resets to new seeded geometry', () => {
    const growth = createPipeGrowth(options);
    const start = growth.frame(0),
      middle = growth.frame(8),
      full = growth.frame(16);
    expect(start.growth.pipeCount).toBe(1);
    expect(middle.growth.stage).toBe('growing');
    expect(middle.scene.indices.length).toBeGreaterThan(start.scene.indices.length);
    expect(full.growth.stage).toBe('holding');
    expect(full.scene.indices.length).toBeGreaterThan(middle.scene.indices.length);
    const clear = growth.frame(17.3);
    expect(clear.growth.stage).toBe('clearing');
    expect(clear.scene.indices.length).toBe(0);
    expect(rasterizePipes(clear.scene, 17.3, view).pixels.every((v) => v === 0)).toBe(true);
    const reset = growth.frame(growth.cycleSeconds);
    expect(reset.growth.cycle).toBe(1);
    expect(reset.growth.progress).toBeCloseTo(0);
    expect(reset.scene.indices.length).toBe(start.scene.indices.length);
    expect(reset.scene.positions).not.toEqual(start.scene.positions);
  });

  it('reproduces arbitrary cycle times, including jumps and revisiting a cycle', () => {
    const a = createPipeGrowth({ ...options, pipes: 4 }),
      b = createPipeGrowth({ ...options, pipes: 4 });
    for (const time of [0, 9, 52, 9, 8.5, 2000]) {
      const first = a.frame(time),
        second = b.frame(time);
      expect(first.growth).toEqual(second.growth);
      expect(first.scene.positions).toEqual(second.scene.positions);
      expect(first.scene.indices).toEqual(second.scene.indices);
      expect(first.scene.groups.length).toBe(4);
    }
    const slow = createPipeGrowth({ ...options, speed: 0.5 });
    expect(slow.frame(8).growth.progress).toBe(0.25);
    expect(createPipeGrowth({ ...options, speed: 4 }).frame(4).growth.stage).toBe('holding');
  });

  it('uses one interpolated tip cap through straight segments and rounded corners', () => {
    const path = preparePipePath([
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
    ]);
    for (const distance of [0.1, 0.69, 0.8, 1, 1.3, 2]) {
      const scene = growingPipeMesh(options, [path], distance);
      const positions = scene.positions;
      expect([...positions, ...scene.normals].every(Number.isFinite)).toBe(true);
      expect(scene.groups.length).toBe(1);
      // Weld duplicate cap vertices by position, then verify a closed surface.
      const edges = new Map(),
        vertex = (i) => Array.from(positions.subarray(i * 3, i * 3 + 3)).join(',');
      for (let i = 0; i < scene.indices.length; i += 3) {
        const tri = Array.from(scene.indices.subarray(i, i + 3), vertex);
        for (let e = 0; e < 3; e++) {
          const key = [tri[e], tri[(e + 1) % 3]].sort().join('/');
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      expect([...edges.values()].every((n) => n === 2)).toBe(true);
    }
  });

  it('keeps the projection fixed as the tube grows and validates all control bounds', () => {
    const growth = createPipeGrowth(options);
    const scene = growth.frame(2).scene;
    // Camera framing must not depend on changing lighting/time.
    const a = rasterizePipes(scene, 0, view),
      b = rasterizePipes(scene, 2, view);
    expect(a.pixels.map((v) => Number(v !== 0))).toEqual(b.pixels.map((v) => Number(v !== 0)));
    for (const change of [
      { pipes: 0 },
      { pipes: 81 },
      { pipes: 1.5 },
      { speed: 0 },
      { speed: NaN },
      { seed: -1 },
    ])
      expect(() => createPipeGrowth({ ...options, ...change })).toThrow(RangeError);
    expect(() => growth.frame(-1)).toThrow(RangeError);
    expect(() => growth.frame(Infinity)).toThrow(RangeError);
    expect(createPipeGrowth({ ...options, pipes: 80 }).frame(1).scene.groups.length).toBe(80);
  });
});
