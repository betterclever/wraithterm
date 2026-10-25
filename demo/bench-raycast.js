// An original retro first-person raycaster for terminal footage: textured walls, cast floor
// and ceiling, and a deterministic camera loop. Textures are procedural; no game assets.
// Cell-centre waypoints of a loop through the corridors.
const PATH = [
  [1, 1],
  [5, 1],
  [5, 3],
  [3, 3],
  [3, 5],
  [1, 5],
  [1, 7],
  [3, 7],
  [3, 9],
  [1, 9],
  [1, 11],
  [5, 11],
  [5, 9],
  [7, 9],
  [7, 13],
  [12, 13],
  [12, 11],
  [9, 11],
  [9, 7],
  [12, 7],
  [12, 3],
  [14, 3],
  [14, 1],
  [8, 1],
  [8, 3],
  [8, 5],
  [6, 5],
  [6, 1],
].map(([x, y]) => [x + 0.5, y + 0.5]);
// Solid rock with the camera loop carved out; wall material varies by 4×4 district.
const MAP = (() => {
  const grid = Array.from({ length: 16 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => 'S#T#'[(Math.floor(x / 4) * 3 + Math.floor(y / 4)) % 4]),
  );
  PATH.forEach(([ax, ay], i) => {
    const [bx, by] = PATH[(i + 1) % PATH.length];
    for (let k = 0; k <= 40; k++) {
      grid[Math.floor(ay + ((by - ay) * k) / 40)][Math.floor(ax + ((bx - ax) * k) / 40)] = '.';
    }
  });
  return grid.map((row) => row.join(''));
})();
const CELLS_PER_SECOND = 2.6;

const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const wall = (x, y) => MAP[Math.floor(y)]?.[Math.floor(x)] ?? '#';

function texture(kind, u, v) {
  if (kind === 'T') {
    // Steel panels with light strips.
    const strip = Math.abs(v - 0.5) < 0.04 ? 1 : 0;
    const seam = u < 0.03 || u > 0.97 || v < 0.03 || v > 0.97;
    const rivet = Math.hypot((u % 0.5) - 0.1, (v % 0.5) - 0.1) < 0.035;
    if (strip) return [255, 170, 80];
    if (rivet) return [150, 160, 170];
    const n = 0.85 + 0.15 * hash(Math.floor(u * 8), Math.floor(v * 8));
    return seam ? [24, 28, 34] : [58 * n, 66 * n, 78 * n];
  }
  if (kind === 'S') {
    const row = Math.floor(v * 3),
      col = Math.floor(u * 2 + row * 0.5);
    const mortar = v * 3 - row < 0.07 || (u * 2 + row * 0.5) % 1 < 0.05;
    const n = 0.7 + 0.3 * hash(col, row);
    return mortar ? [30, 30, 32] : [110 * n, 108 * n, 102 * n];
  }
  const row = Math.floor(v * 6),
    col = Math.floor(u * 3 + (row & 1) * 0.5);
  const mortar = v * 6 - row < 0.12 || (u * 3 + (row & 1) * 0.5) % 1 < 0.06;
  const n = 0.75 + 0.25 * hash(col * 3.1, row * 1.7);
  return mortar ? [38, 24, 18] : [150 * n, 62 * n, 38 * n];
}

function pathPoint(d) {
  let total = 0;
  const lengths = PATH.map((p, i) => {
    const q = PATH[(i + 1) % PATH.length];
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  const loop = lengths.reduce((a, b) => a + b, 0);
  d = ((d % loop) + loop) % loop;
  for (let i = 0; i < PATH.length; i++) {
    if (total + lengths[i] >= d) {
      const k = (d - total) / lengths[i],
        p = PATH[i],
        q = PATH[(i + 1) % PATH.length];
      return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
    }
    total += lengths[i];
  }
  return PATH[0];
}

// Smooth the polyline by averaging nearby samples, and look ahead along it.
function camera(t) {
  const d = t * CELLS_PER_SECOND;
  const avg = (o) => {
    let x = 0,
      y = 0;
    for (let k = -4; k <= 4; k++) {
      const [px, py] = pathPoint(d + o + k * 0.12);
      x += px;
      y += py;
    }
    return [x / 9, y / 9];
  };
  const pos = avg(0),
    ahead = avg(0.9);
  return { pos, angle: Math.atan2(ahead[1] - pos[1], ahead[0] - pos[0]) };
}

/** RGB pixels (w × h × 3) of the scene at time t seconds. */
export function raycastPixels(w, h, t) {
  const out = new Uint8Array(w * h * 3);
  const { pos, angle } = camera(t);
  const bob = Math.sin(t * CELLS_PER_SECOND * Math.PI * 1.6) * 0.012 * h;
  const fov = 0.66,
    dirX = Math.cos(angle),
    dirY = Math.sin(angle),
    planeX = -dirY * fov,
    planeY = dirX * fov;
  const horizon = h / 2 + bob,
    fog = [40, 18, 8];
  const put = (i, c, light) => {
    const f = Math.min(1, light);
    out[i] = c[0] * f + fog[0] * (1 - f);
    out[i + 1] = c[1] * f + fog[1] * (1 - f);
    out[i + 2] = c[2] * f + fog[2] * (1 - f);
  };
  for (let x = 0; x < w; x++) {
    const cam = (2 * x) / w - 1,
      rx = dirX + planeX * cam,
      ry = dirY + planeY * cam;
    let mx = Math.floor(pos[0]),
      my = Math.floor(pos[1]);
    const ddx = Math.abs(1 / rx),
      ddy = Math.abs(1 / ry);
    const sx = rx < 0 ? -1 : 1,
      sy = ry < 0 ? -1 : 1;
    let sdx = (rx < 0 ? pos[0] - mx : mx + 1 - pos[0]) * ddx,
      sdy = (ry < 0 ? pos[1] - my : my + 1 - pos[1]) * ddy,
      side = 0;
    for (let i = 0; i < 64 && wall(mx, my) === '.'; i++) {
      if (sdx < sdy) {
        sdx += ddx;
        mx += sx;
        side = 0;
      } else {
        sdy += ddy;
        my += sy;
        side = 1;
      }
    }
    const dist = Math.max(0.05, side ? sdy - ddy : sdx - ddx);
    const hitX = side ? pos[0] + dist * rx : pos[1] + dist * ry;
    const u = hitX - Math.floor(hitX),
      lineH = h / dist,
      top = horizon - lineH / 2;
    const kind = wall(mx, my),
      light = (side ? 0.72 : 1) * Math.min(1.25, 2.6 / (dist + 0.6));
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 3;
      if (y >= top && y < top + lineH) {
        put(i, texture(kind, u, (y - top) / lineH), light);
        continue;
      }
      // Floor and ceiling casting.
      const floor = y > horizon,
        rowDist = h / 2 / Math.max(0.5, Math.abs(y - horizon));
      const wx = pos[0] + rowDist * rx,
        wy = pos[1] + rowDist * ry;
      const fx = Math.floor(wx),
        fy = Math.floor(wy),
        lx = wx - fx,
        ly = wy - fy;
      let c;
      if (floor) {
        const checker = (fx + fy) & 1,
          edge = lx < 0.04 || ly < 0.04;
        c = edge ? [20, 14, 12] : checker ? [66, 44, 34] : [52, 36, 30];
      } else {
        const lamp = (fx + fy) % 3 === 0 && Math.abs(lx - 0.5) < 0.22 && Math.abs(ly - 0.5) < 0.22;
        c = lamp ? [255, 214, 150] : [34, 30, 34];
      }
      put(i, c, (lamp(c) ? 1.2 : 1) * Math.min(1.1, 2.2 / (rowDist + 0.5)));
    }
  }
  return out;
}
const lamp = (c) => c[0] === 255;
