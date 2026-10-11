import { PIPE_PRESETS, PIPE_SEED, preparePipePath, growingPipeMesh } from './pipes-scene.js';

const axes = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let n = Math.imul(state ^ (state >>> 15), state | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

function network(count, seed) {
  const rng = random(seed),
    occupied = new Set(),
    paths = [];
  const free = (p) => p.every((v) => Math.abs(v) <= 5) && !occupied.has(p.join(','));
  // Allocate every starting point before walking; no pipe consumes another's start.
  for (let i = 0; i < count; i++) {
    let p;
    do {
      p = Array.from({ length: 3 }, () => Math.floor(rng() * 7) - 3);
    } while (!free(p));
    occupied.add(p.join(','));
    paths.push({ points: [p], previous: undefined });
  }
  for (let step = 0; step < 128; step++)
    for (const path of paths) {
      const last = path.points.at(-1);
      const choices = axes.filter((d) => free(last.map((v, i) => v + d[i])));
      if (!choices.length) continue;
      const d =
        path.previous && choices.includes(path.previous) && rng() < 0.6
          ? path.previous
          : choices[Math.floor(rng() * choices.length)];
      const next = last.map((v, i) => v + d[i]);
      occupied.add(next.join(','));
      path.points.push(next);
      path.previous = d;
    }
  // A fully surrounded starting point still gets a small sealed stub.
  return paths.map(({ points }) =>
    preparePipePath(
      points.length > 1 ? points : [points[0], [points[0][0] + 0.25, points[0][1], points[0][2]]],
    ),
  );
}

/** Deterministic continuous growth: grow, hold, clear, then generate a new network. */
export function createPipeGrowth(options = {}) {
  const config = { ...PIPE_PRESETS.pressure, pipes: 1, seed: PIPE_SEED, speed: 1, ...options };
  for (const [key, min, max] of [
    ['cols', 16, 320],
    ['rows', 8, 120],
    ['pipes', 1, 80],
    ['sides', 6, 16],
    ['seed', 0, 0xffffffff],
  ])
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max)
      throw new RangeError(`Invalid ${key}`);
  if (!Number.isFinite(config.speed) || config.speed < 0.25 || config.speed > 4)
    throw new RangeError('Growth speed must be 0.25..4');
  const growSeconds = 16 / config.speed,
    holdSeconds = 1.2,
    clearSeconds = 0.35;
  const cycleSeconds = growSeconds + holdSeconds + clearSeconds;
  let currentCycle = -1,
    paths,
    cycleSeed,
    longest;
  return {
    config,
    cycleSeconds,
    frame(time) {
      if (!Number.isFinite(time) || time < 0)
        throw new RangeError('Growth time must be finite and nonnegative');
      const cycle = Math.floor(time / cycleSeconds),
        phase = time - cycle * cycleSeconds;
      if (cycle !== currentCycle) {
        currentCycle = cycle;
        cycleSeed = (config.seed + Math.imul(cycle, 0x9e3779b9)) >>> 0;
        paths = network(config.pipes, cycleSeed);
        longest = Math.max(...paths.map((p) => p.distance));
      }
      const stage =
        phase < growSeconds
          ? 'growing'
          : phase < growSeconds + holdSeconds
            ? 'holding'
            : 'clearing';
      const progress = Math.min(1, phase / growSeconds);
      const distance = stage === 'clearing' ? 0 : Math.max(0.12, longest * progress);
      const scene = growingPipeMesh({ ...config, seed: cycleSeed }, paths, distance);
      return {
        scene,
        growth: {
          cycle,
          stage,
          progress,
          distance,
          pipeCount: config.pipes,
          cycleSeconds,
          seed: cycleSeed,
        },
      };
    },
  };
}
