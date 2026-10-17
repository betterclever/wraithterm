import { describe, expect, it } from 'vitest';
import { createPipeGrowth } from './pipes-growth.js';
import { preparePipePath, growingPipeMesh, rasterizePipes } from './pipes-scene.js';

const options = { cols: 72, rows: 32, pipes: 1, seed: 95, sides: 10 };
const view = { camera: 'fixed', framing: 'lattice', backdrop: 'black' };
describe('XP pipe growth', () => {
  it('keeps growing beyond the old timeout, fills, clears, and starts a new seeded scene', () => {
    const growth = createPipeGrowth(options);
    const start = growth.frame(0),
      middle = growth.frame(30),
      full = growth.frame(growth.growSeconds);
    expect(start.growth.pipeCount).toBe(1);
    expect(start.scene.groups.length).toBe(1);
    expect(middle.growth.stage).toBe('growing');
    expect(middle.growth.activePipes).toBe(1);
    expect(middle.scene.indices.length).toBeGreaterThan(start.scene.indices.length);
    expect(full.growth.stage).toBe('holding');
    expect(full.growth.activePipes).toBe(0);
    expect(full.growth.completedPipes).toBeGreaterThan(1);
    expect(full.scene.indices.length).toBeGreaterThan(middle.scene.indices.length);
    const clear = growth.frame(growth.cycleSeconds - 0.05);
    expect(clear.growth.stage).toBe('clearing');
    expect(clear.scene.indices.length).toBe(0);
    expect(clear.growth.activePipes).toBe(0);
    expect(clear.growth.completedPipes).toBe(0);
    expect(rasterizePipes(clear.scene, 17.3, view).pixels.every((v) => v === 0)).toBe(true);
    const reset = growth.frame(growth.cycleSeconds);
    expect(reset.growth.cycle).toBe(1);
    expect(reset.growth.progress).toBeCloseTo(0);
    expect(reset.scene.indices.length).toBe(start.scene.indices.length);
    expect(reset.scene.positions).not.toEqual(start.scene.positions);
  });

  it('retains completed tubes unchanged while replacement colors keep growing', () => {
    const growth = createPipeGrowth(options);
    const a = growth.frame(growth.growSeconds * 0.4),
      b = growth.frame(growth.growSeconds * 0.6);
    expect(a.growth.completedPipes).toBeGreaterThan(0);
    expect(b.growth.completedPipes).toBeGreaterThan(a.growth.completedPipes);
    expect(a.growth.activePipes).toBe(1);
    expect(b.growth.activePipes).toBe(1);
    expect(b.growth.distance).toBeGreaterThan(a.growth.distance);
    const tubeVertices = (scene) => {
      const group = scene.groups[0];
      return Array.from(scene.indices.subarray(group.offset, group.end), (i) =>
        Array.from(scene.positions.subarray(i * 3, i * 3 + 3)),
      );
    };
    expect(tubeVertices(a.scene)).toEqual(tubeVertices(b.scene));
    expect(a.scene.groups[0].color).toEqual(b.scene.groups[0].color);
    expect(b.scene.groups[1].color).not.toEqual(b.scene.groups[0].color);
  });

  it('reproduces arbitrary cycle times, including jumps and revisiting cached geometry', () => {
    const a = createPipeGrowth({ ...options, pipes: 4 }),
      b = createPipeGrowth({ ...options, pipes: 4 });
    for (const time of [0, 9, 52, 9, 8.5, 2000]) {
      const first = a.frame(time),
        second = b.frame(time);
      expect(first.growth).toEqual(second.growth);
      expect(first.scene.positions).toEqual(second.scene.positions);
      expect(first.scene.indices).toEqual(second.scene.indices);
      expect(first.growth.activePipes).toBeLessThanOrEqual(4);
      // Completed tubes from a future frame must not leak into a backward seek.
      expect(first.scene.positions).toEqual(
        createPipeGrowth({ ...options, pipes: 4 }).frame(time).scene.positions,
      );
    }
    const slow = createPipeGrowth({ ...options, speed: 0.5 });
    const normal = createPipeGrowth(options);
    expect(slow.frame(8).scene.positions).toEqual(normal.frame(4).scene.positions);
    expect(createPipeGrowth({ ...options, speed: 4 }).frame(4).scene.positions).toEqual(
      normal.frame(16).scene.positions,
    );
  });

  it('bounds accumulated geometry across dense scenes and repeated resets', () => {
    for (const pipes of [1, 6, 80]) {
      const growth = createPipeGrowth({ ...options, pipes });
      expect(growth.frame(0).growth.activePipes).toBe(pipes);
      for (const cycle of [0, 1, 20]) {
        const { scene, growth: state } = growth.frame(
          cycle * growth.cycleSeconds + growth.growSeconds + 0.1,
        );
        expect(state.completedPipes).toBeGreaterThan(pipes);
        expect(scene.stats.segments + scene.stats.pipes).toBeLessThanOrEqual(
          Math.floor(11 ** 3 * 0.7) + 1,
        );
        expect(scene.positions.every(Number.isFinite)).toBe(true);
      }
    }
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

  it('caches only complete geometry and preserves partial tips during backward seeks', () => {
    const path = preparePipePath([
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ]),
      cache = new Map();
    const expected = growingPipeMesh(options, [path], path.distance);
    expect(growingPipeMesh(options, [path], [0.5], cache).indices.length).toBeLessThan(
      expected.indices.length,
    );
    expect(cache.size).toBe(0);
    expect(growingPipeMesh(options, [path], [path.distance], cache)).toEqual(expected);
    const retained = cache.get(path);
    expect(growingPipeMesh(options, [path], [0.5], cache)).toEqual(
      growingPipeMesh(options, [path], 0.5),
    );
    expect(growingPipeMesh(options, [path], [path.distance], cache)).toEqual(expected);
    expect(cache.get(path)).toBe(retained);
    expect(growingPipeMesh(options, [path], [0], cache).stats.pipes).toBe(0);
    for (const distances of [[], [-1], [NaN], [Infinity]])
      expect(() => growingPipeMesh(options, [path], distances)).toThrow(RangeError);
  });

  it('rotates in 3D without reframing the growing geometry and validates control bounds', () => {
    const growth = createPipeGrowth(options);
    const scene = growth.frame(2).scene;
    const orbit = { ...view, camera: 'orbit' };
    const a = rasterizePipes(scene, 0, orbit),
      b = rasterizePipes(scene, 2, orbit);
    expect(a.pixels.map((v) => Number(v !== 0))).not.toEqual(b.pixels.map((v) => Number(v !== 0)));
    // An invisible far-off vertex must not change the framing of the same tube.
    const padded = {
      ...scene,
      positions: new Float32Array([...scene.positions, 5.24, 5.24, 5.24]),
      normals: new Float32Array([...scene.normals, 1, 0, 0]),
    };
    expect(rasterizePipes(padded, 2, orbit).pixels).toEqual(b.pixels);
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
    expect(createPipeGrowth({ ...options, pipes: 80 }).frame(0).scene.groups.length).toBe(80);
  });
});
