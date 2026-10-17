// A software 3D scene whose only display output is a standard ANSI byte stream.
// No canvas, image escape sequence, terminal-specific extension, or DOM drawing.
export const PIPE_PRESETS = Object.freeze({
  classic: { cols: 120, rows: 42, pipes: 12, length: 18, sides: 10 },
  pressure: { cols: 180, rows: 60, pipes: 28, length: 22, sides: 12 },
  inferno: { cols: 240, rows: 80, pipes: 52, length: 28, sides: 14 },
});
export const PIPE_SEED = 0x199503;
const TAU = Math.PI * 2;
const encoder = new TextEncoder();
const palette = [
  [0.95, 0.12, 0.09],
  [0.08, 0.5, 1],
  [1, 0.64, 0.09],
  [0.13, 0.85, 0.36],
  [0.76, 0.19, 0.92],
  [0.1, 0.88, 0.86],
  [0.94, 0.39, 0.12],
  [0.7, 0.77, 0.88],
];
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, n) => a.map((v) => v * n);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a) => mul(a, 1 / (Math.hypot(...a) || 1));
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
function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer in ${min}..${max}`);
}

/** The same smooth centerline is used for complete pipes and moving tips. */
export function preparePipePath(path) {
  const rings = [{ p: path[0], t: unit(sub(path[1], path[0])) }];
  let elbows = 0;
  const bend = 0.32;
  for (let i = 1; i < path.length - 1; i++) {
    const p = path[i],
      a = unit(sub(p, path[i - 1])),
      b = unit(sub(path[i + 1], p));
    if (dot(a, b) > 0.99) {
      rings.push({ p, t: a });
      continue;
    }
    elbows++;
    const center = add(sub(p, mul(a, bend)), mul(b, bend));
    for (let k = 0; k <= 5; k++) {
      const angle = ((k / 5) * Math.PI) / 2;
      rings.push({
        p: add(center, mul(sub(mul(a, Math.sin(angle)), mul(b, Math.cos(angle))), bend)),
        t: add(mul(a, Math.cos(angle)), mul(b, Math.sin(angle))),
      });
    }
  }
  rings.push({ p: path.at(-1), t: unit(sub(path.at(-1), path.at(-2))) });
  let distance = 0;
  for (let i = 0; i < rings.length; i++) {
    if (i) distance += Math.hypot(...sub(rings[i].p, rings[i - 1].p));
    rings[i].distance = distance;
  }
  return { rings, distance, elbows, segments: path.length - 1 };
}

function appendTube(mesh, rings, sides, radius) {
  const { positions, normals, indices } = mesh;
  const vertex = (p, n) => {
    const index = positions.length / 3;
    positions.push(...p);
    normals.push(...n);
    return index;
  };
  let basis = unit(cross(rings[0].t, Math.abs(rings[0].t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const first = positions.length / 3,
    offset = indices.length;
  for (const ring of rings) {
    basis = unit(sub(basis, mul(ring.t, dot(basis, ring.t))));
    const binormal = cross(ring.t, basis);
    for (let s = 0; s < sides; s++) {
      const angle = (s / sides) * TAU;
      const n = add(mul(basis, Math.cos(angle)), mul(binormal, Math.sin(angle)));
      vertex(add(ring.p, mul(n, radius)), n);
    }
  }
  for (let r = 0; r < rings.length - 1; r++)
    for (let s = 0; s < sides; s++) {
      const a = first + r * sides + s,
        b = first + r * sides + ((s + 1) % sides);
      indices.push(a, b, a + sides, b, b + sides, a + sides);
    }
  // The moving tip has its own perpendicular cap, including inside an elbow.
  for (const r of [0, rings.length - 1]) {
    const ring = rings[r],
      n = mul(ring.t, r === 0 ? -1 : 1);
    const center = vertex(ring.p, n),
      edge = positions.length / 3;
    for (let s = 0; s < sides; s++) {
      const at = (first + r * sides + s) * 3;
      vertex(positions.slice(at, at + 3), n);
    }
    for (let s = 0; s < sides; s++) indices.push(center, edge + s, edge + ((s + 1) % sides));
  }
  return { offset, end: indices.length };
}

/** Grow sealed tubes; callers may retain completed meshes for this config/cycle. */
export function growingPipeMesh(config, paths, distances, completedMeshes) {
  const perPath = Array.isArray(distances);
  if (perPath && distances.length !== paths.length)
    throw new RangeError('Missing growth distances');
  for (const distance of perPath ? distances : [distances])
    if (!Number.isFinite(distance) || distance < 0) throw new RangeError('Invalid growth distance');
  const tubes = [];
  let segments = 0,
    elbows = 0,
    vertexFloats = 0,
    indexCount = 0;
  for (const [index, path] of paths.entries()) {
    const distance = perPath ? distances[index] : distances;
    if (distance === 0) continue;
    const complete = distance >= path.distance;
    let tube = complete ? completedMeshes?.get(path) : undefined;
    if (!tube) {
      const visible = [path.rings[0]];
      for (let r = 1; r < path.rings.length; r++) {
        const ring = path.rings[r],
          prev = path.rings[r - 1];
        if (ring.distance <= distance) {
          visible.push(ring);
          continue;
        }
        if (distance > prev.distance) {
          const f = (distance - prev.distance) / (ring.distance - prev.distance);
          visible.push({
            p: add(prev.p, mul(sub(ring.p, prev.p), f)),
            t: unit(add(mul(prev.t, 1 - f), mul(ring.t, f))),
          });
        }
        break;
      }
      if (visible.length < 2) continue;
      const mesh = { positions: [], normals: [], indices: [] };
      appendTube(mesh, visible, config.sides, 0.24);
      tube = {
        positions: new Float32Array(mesh.positions),
        normals: new Float32Array(mesh.normals),
        indices: new Uint32Array(mesh.indices),
        segments: Math.ceil(path.segments * Math.min(1, distance / path.distance)),
        elbows: visible.filter((ring, i) => i && dot(ring.t, visible[i - 1].t) < 0.99).length / 5,
      };
      if (complete) completedMeshes?.set(path, tube);
    }
    tubes.push({ tube, index });
    vertexFloats += tube.positions.length;
    indexCount += tube.indices.length;
    segments += tube.segments;
    elbows += tube.elbows;
  }
  const positions = new Float32Array(vertexFloats),
    normals = new Float32Array(vertexFloats),
    indices = new Uint32Array(indexCount),
    groups = [];
  let vertexOffset = 0,
    indexOffset = 0;
  for (const { tube, index } of tubes) {
    positions.set(tube.positions, vertexOffset);
    normals.set(tube.normals, vertexOffset);
    for (let i = 0; i < tube.indices.length; i++)
      indices[indexOffset + i] = tube.indices[i] + vertexOffset / 3;
    groups.push({
      offset: indexOffset,
      end: indexOffset + tube.indices.length,
      color: palette[(index + (config.seed & 7)) % palette.length],
      phase: index,
    });
    vertexOffset += tube.positions.length;
    indexOffset += tube.indices.length;
  }
  return {
    config,
    positions,
    normals,
    indices,
    groups,
    stats: {
      pipes: groups.length,
      segments,
      elbows: Math.round(elbows),
      triangles: indices.length / 3,
    },
  };
}

/** Seeded, non-intersecting lattice walks, swept into round cylinders and torus elbows. */
export function createPipesScene(options = {}) {
  const config = { ...PIPE_PRESETS.pressure, seed: PIPE_SEED, ...options };
  integer(config.cols, 16, 320, 'cols');
  integer(config.rows, 8, 120, 'rows');
  integer(config.pipes, 1, 80, 'pipes');
  integer(config.length, 2, 40, 'length');
  integer(config.sides, 6, 16, 'sides');
  integer(config.seed, 0, 0xffffffff, 'seed');
  const rng = random(config.seed);
  const occupied = new Set();
  const positions = [],
    normals = [],
    indices = [],
    groups = [];
  let elbows = 0,
    segments = 0;
  for (let pipe = 0; pipe < config.pipes; pipe++) {
    let start;
    for (let attempt = 0; attempt < 200; attempt++) {
      const p = Array.from({ length: 3 }, () => Math.floor(rng() * 11) - 5);
      if (!occupied.has(p.join(','))) {
        start = p;
        break;
      }
    }
    if (!start) break;
    occupied.add(start.join(','));
    const path = [start];
    let previous;
    for (let step = 0; step < config.length; step++) {
      const current = path.at(-1);
      const possible = axes.filter((d) => {
        const p = add(current, d);
        return p.every((v) => Math.abs(v) <= 5) && !occupied.has(p.join(','));
      });
      if (!possible.length) break;
      const d =
        previous && possible.includes(previous) && rng() < 0.35
          ? previous
          : possible[Math.floor(rng() * possible.length)];
      const p = add(current, d);
      occupied.add(p.join(','));
      path.push(p);
      previous = d;
    }
    if (path.length < 2) continue;
    const prepared = preparePipePath(path);
    segments += prepared.segments;
    elbows += prepared.elbows;
    const radius = 0.14 + rng() * 0.035;
    const geometry = appendTube(
      { positions, normals, indices },
      prepared.rings,
      config.sides,
      radius,
    );
    groups.push({
      ...geometry,
      color: palette[pipe % palette.length],
      phase: rng() * TAU,
    });
  }
  return {
    config,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    groups,
    stats: { pipes: groups.length, segments, elbows, triangles: indices.length / 3 },
  };
}

/** Perspective-correct, depth-tested software rasterization at two pixels per terminal cell. */
export function rasterizePipes(
  scene,
  time = 0,
  { colors = 'truecolor', camera = 'orbit', framing = 'mesh', backdrop = 'ember' } = {},
) {
  if (!Number.isFinite(time)) throw new RangeError('time must be finite');
  if (!['truecolor', 'rgb444'].includes(colors)) throw new RangeError('Unknown color mode');
  const { cols: width, rows } = scene.config,
    height = rows * 2;
  const pixels = new Uint32Array(width * height),
    depth = new Float32Array(pixels.length);
  const cameraTime = camera === 'fixed' ? 0 : time;
  const yaw = 0.47 + cameraTime * 0.19,
    pitch = -0.3 + Math.sin(cameraTime * 0.11) * 0.14;
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  let extentX = 0,
    extentY = 0;
  const projected = new Float32Array((scene.positions.length / 3) * 6);
  const rotate = (x, y, z) => {
    const xx = cy * x + sy * z,
      zz = -sy * x + cy * z;
    return [xx, cp * y - sp * zz, sp * y + cp * zz];
  };
  // The site's ember background and drifting stars are also terminal pixels.
  if (backdrop !== 'black')
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const v = 3 + Math.round(4 * (1 - y / height));
        pixels[y * width + x] = ((v + 5) << 16) | ((v + 1) << 8) | v;
      }
  const stars = random(scene.config.seed ^ 0xa5a5a5a5);
  for (let i = 0; backdrop !== 'black' && i < 70; i++) {
    const x = Math.floor((((stars() * width + time * 0.3) % width) + width) % width),
      y = Math.floor(stars() * height);
    pixels[y * width + x] = 0x443226;
  }
  if (framing === 'lattice') {
    // A sphere enclosing the lattice keeps the zoom constant through every
    // camera angle, including while new pipes change the scene's bounds.
    const radius = Math.sqrt(3) * 5.25;
    extentX = extentY = radius / Math.sqrt(20 ** 2 - radius ** 2);
  }
  for (let i = 0; i < scene.positions.length; i += 3) {
    const [x, y, z] = rotate(scene.positions[i], scene.positions[i + 1], scene.positions[i + 2]);
    const n = rotate(scene.normals[i], scene.normals[i + 1], scene.normals[i + 2]);
    const invZ = 1 / (z + 20),
      at = i * 2;
    projected[at] = x * invZ;
    projected[at + 1] = -y * invZ;
    extentX = Math.max(extentX, Math.abs(projected[at]));
    extentY = Math.max(extentY, Math.abs(projected[at + 1]));
    projected[at + 2] = invZ;
    projected[at + 3] = n[0] * invZ;
    projected[at + 4] = n[1] * invZ;
    projected[at + 5] = n[2] * invZ;
  }
  // Fit the complete rotating network with a small margin; don't clip its ends.
  const focal = Math.min((width * 0.465) / extentX, (height * 0.465) / extentY);
  for (let at = 0; at < projected.length; at += 6) {
    projected[at] = width * 0.5 + projected[at] * focal;
    projected[at + 1] = height * 0.5 + projected[at + 1] * focal;
  }
  let fragments = 0;
  const channel = (v) => {
    const byte = Math.max(0, Math.min(255, Math.round(v * 255)));
    return byte;
  };
  for (const group of scene.groups) {
    const [red, green, blue] = group.color;
    const pulse = camera === 'fixed' ? 1 : 0.95 + 0.05 * Math.sin(time * 1.7 + group.phase);
    for (let t = group.offset; t < group.end; t += 3) {
      const a = scene.indices[t] * 6,
        b = scene.indices[t + 1] * 6,
        c = scene.indices[t + 2] * 6;
      const ax = projected[a],
        ay = projected[a + 1],
        bx = projected[b],
        by = projected[b + 1],
        cx = projected[c],
        cyy = projected[c + 1];
      const area = (bx - ax) * (cyy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 0.0001) continue;
      const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5));
      const maxX = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
      const minY = Math.max(0, Math.ceil(Math.min(ay, by, cyy) - 0.5));
      const maxY = Math.min(height - 1, Math.floor(Math.max(ay, by, cyy) - 0.5));
      const invArea = 1 / area;
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          const u = ((bx - x - 0.5) * (cyy - y - 0.5) - (by - y - 0.5) * (cx - x - 0.5)) * invArea;
          const v = ((cx - x - 0.5) * (ay - y - 0.5) - (cyy - y - 0.5) * (ax - x - 0.5)) * invArea;
          const w = 1 - u - v;
          if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
          const iz = u * projected[a + 2] + v * projected[b + 2] + w * projected[c + 2],
            at = y * width + x;
          if (iz <= depth[at]) continue;
          depth[at] = iz;
          fragments++;
          let nx = u * projected[a + 3] + v * projected[b + 3] + w * projected[c + 3];
          let ny = u * projected[a + 4] + v * projected[b + 4] + w * projected[c + 4];
          let nz = u * projected[a + 5] + v * projected[b + 5] + w * projected[c + 5];
          const norm = 1 / (Math.hypot(nx, ny, nz) || 1);
          nx *= norm;
          ny *= norm;
          nz *= norm;
          // Two cool studio strips, a warm key light and a tight metallic highlight.
          const diffuse = Math.max(0, nx * -0.42 + ny * 0.62 - nz * 0.66);
          const spec = Math.pow(Math.max(0, nx * -0.23 + ny * 0.34 - nz * 0.91), 44);
          const strip = Math.pow(Math.max(0, nx * 0.88 + ny * 0.12 - nz * 0.46), 22) * 0.65;
          const rim = Math.pow(1 - Math.abs(nz), 3) * 0.23;
          const fog = Math.min(1, Math.max(0.35, (iz - 0.032) * 26));
          const light = (0.14 + diffuse * 0.82 + rim) * pulse;
          const r = channel((red * light + spec * 0.95 + strip * 0.4) * fog);
          const g = channel((green * light + spec * 0.9 + strip * 0.65) * fog);
          const bcolor = channel((blue * light + spec * 0.82 + strip) * fog);
          pixels[at] = (r << 16) | (g << 8) | bcolor;
        }
    }
  }
  if (colors === 'rgb444')
    for (let i = 0; i < pixels.length; i++) {
      const v = pixels[i],
        quantize = (c) => Math.round(c / 17) * 17;
      pixels[i] = (quantize(v >>> 16) << 16) | (quantize((v >>> 8) & 255) << 8) | quantize(v & 255);
    }
  return { pixels, width, height, fragments };
}

const rgb = (v) => `${v >>> 16};${(v >>> 8) & 255};${v & 255}`;
/** A complete independent frame, with explicit row positioning and wrap disabled.
 * stress emits one combined truecolor SGR per cell; compact elides unchanged colors.
 * Both decode to exactly the same cells. Cursor/wrap are restored by the CLI on exit.
 */
export function encodePipeFrame(image, { traffic = 'stress' } = {}) {
  if (!['stress', 'compact'].includes(traffic)) throw new RangeError('Unknown traffic mode');
  const { pixels, width, height } = image;
  if (height % 2 || pixels.length !== width * height) throw new RangeError('Invalid pixel grid');
  const chunks = ['\x1b[0m\x1b[?25l\x1b[?7l'];
  let fg = -1,
    bg = -1,
    sgrChanges = 2;
  for (let y = 0; y < height; y += 2) {
    chunks.push(`\x1b[${y / 2 + 1};1H`);
    for (let x = 0; x < width; x++) {
      const top = pixels[y * width + x],
        bottom = pixels[(y + 1) * width + x];
      if (traffic === 'stress' || top !== fg || bottom !== bg) {
        chunks.push(`\x1b[38;2;${rgb(top)};48;2;${rgb(bottom)}m`);
        fg = top;
        bg = bottom;
        sgrChanges++;
      }
      chunks.push('▀');
    }
  }
  chunks.push('\x1b[0m\x1b[H');
  return { bytes: encoder.encode(chunks.join('')), sgrChanges };
}

// Eight precomputed camera positions are shared by every renderer in the benchmark.
// Generation and encoding occur before any parse/render timers start.
let benchmarkScene;
export function pipesWorkload(cols, rows, variant) {
  if (!benchmarkScene || benchmarkScene.config.cols !== cols || benchmarkScene.config.rows !== rows)
    benchmarkScene = createPipesScene({ ...PIPE_PRESETS.inferno, cols, rows });
  const image = rasterizePipes(benchmarkScene, variant * 0.37);
  return { ...encodePipeFrame(image), variant, scene: benchmarkScene.stats };
}
