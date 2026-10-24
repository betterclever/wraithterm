import { PIPE_PRESETS, PIPE_SEED, preparePipePath, growingPipeMesh } from './pipes-scene.js';

const axes = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const latticeSize = 11 ** 3;
const fillLimit = Math.floor(latticeSize * 0.7);
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let n = Math.imul(state ^ (state >>> 15), state | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

// Plan one bounded cycle. Stopped pipes remain in the scene; their slot immediately
// starts a new color elsewhere. Birth times make seeking independent of frame rate.
function network(count, seed) {
  const rng = random(seed),
    occupied = new Set(),
    paths = [];
  const free = (p) => p.every((v) => Math.abs(v) <= 5) && !occupied.has(p.join(','));
  const choicesAt = (p) => axes.filter((d) => free(p.map((v, i) => v + d[i])));
  function start(birth) {
    // Reserve the first edge as well, so another head cannot strand a new start.
    let candidates = [];
    for (let attempt = 0; attempt < 32; attempt++) {
      const p = Array.from(
        { length: 3 },
        () => Math.floor(rng() * (birth ? 11 : 7)) - (birth ? 5 : 3),
      );
      if (free(p) && choicesAt(p).length) {
        candidates = [p];
        break;
      }
    }
    // Bounded exhaustive fallback near saturation; isolated holes are not starts.
    if (!candidates.length)
      for (let x = -5; x <= 5; x++)
        for (let y = -5; y <= 5; y++)
          for (let z = -5; z <= 5; z++) {
            const p = [x, y, z];
            if (free(p) && choicesAt(p).length) candidates.push(p);
          }
    if (!candidates.length) return undefined;
    const p = candidates[Math.floor(rng() * candidates.length)],
      choices = choicesAt(p),
      d = choices[Math.floor(rng() * choices.length)],
      next = p.map((v, i) => v + d[i]);
    occupied.add(p.join(','));
    occupied.add(next.join(','));
    const path = { points: [p, next], previous: d, birth, limit: 32 + Math.floor(rng() * 49) };
    paths.push(path);
    return path;
  }
  const heads = Array.from({ length: count }, () => start(0));
  let steps = 1;
  while (occupied.size < fillLimit && heads.some(Boolean)) {
    for (let i = 0; i < heads.length && occupied.size < fillLimit; i++) {
      const path = heads[i];
      if (!path) continue;
      const last = path.points.at(-1),
        choices = choicesAt(last);
      if (!choices.length || path.points.length - 1 >= path.limit) {
        heads[i] = start(steps);
        continue;
      }
      const d =
        choices.includes(path.previous) && rng() < 0.6
          ? path.previous
          : choices[Math.floor(rng() * choices.length)];
      const next = last.map((v, axis) => v + d[axis]);
      occupied.add(next.join(','));
      path.points.push(next);
      path.previous = d;
    }
    steps++;
  }
  return {
    paths: paths.map(({ points, birth }) => ({ ...preparePipePath(points), birth })),
    steps,
  };
}

/** Continuous XP-style accumulation, followed by a brief clear and a new layout. */
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
  // More heads fill the scene sooner, without turning the 80-head setting into
  // a blink-and-clear loop. A fixed per-count duration also permits O(1) seeking.
  const growSeconds = 60 / Math.sqrt(config.pipes) / config.speed,
    holdSeconds = 0.6,
    clearSeconds = 0.15;
  const cycleSeconds = growSeconds + holdSeconds + clearSeconds;
  let currentCycle = -1,
    paths,
    steps,
    cycleSeed;
  const completedMeshes = new Map();
  return {
    config,
    growSeconds,
    cycleSeconds,
    frame(time) {
      if (!Number.isFinite(time) || time < 0)
        throw new RangeError('Growth time must be finite and nonnegative');
      const cycle = Math.floor(time / cycleSeconds),
        phase = time - cycle * cycleSeconds;
      if (cycle !== currentCycle) {
        currentCycle = cycle;
        completedMeshes.clear();
        cycleSeed = (config.seed + Math.imul(cycle, 0x9e3779b9)) >>> 0;
        ({ paths, steps } = network(config.pipes, cycleSeed));
      }
      const stage =
        phase < growSeconds
          ? 'growing'
          : phase < growSeconds + holdSeconds
            ? 'holding'
            : 'clearing';
      const progress = Math.min(1, phase / growSeconds),
        step = steps * progress;
      const distances = paths.map((path) =>
        stage === 'clearing' || step < path.birth
          ? 0
          : Math.min(
              path.distance,
              Math.max(0.12, ((step - path.birth) / path.segments) * path.distance),
            ),
      );
      const activePipes = paths.filter(
        (path, i) => distances[i] > 0 && step < path.birth + path.segments,
      ).length;
      const scene = growingPipeMesh(
        { ...config, seed: cycleSeed },
        paths,
        distances,
        completedMeshes,
      );
      return {
        scene,
        growth: {
          cycle,
          stage,
          progress,
          distance: distances.reduce((sum, distance) => sum + distance, 0),
          pipeCount: config.pipes,
          activePipes,
          completedPipes: scene.stats.pipes - activePipes,
          cycleSeconds,
          seed: cycleSeed,
        },
      };
    },
  };
}
