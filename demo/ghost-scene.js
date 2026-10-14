// Every pixel and label below becomes ordinary ANSI terminal content.
import sprite from './ghost-sprite.json' with { type: 'json' };
const BG = [12, 8, 6],
  AMBER = [255, 184, 107],
  LILAC = [217, 187, 255];
const encoder = new TextEncoder();
const hash = (i) => {
  let v = Math.imul(i + 917, 0x45d9f3b);
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
};
const smooth = (v) => {
  const k = Math.max(0, Math.min(1, v));
  return k * k * (3 - 2 * k);
};
const rgb = (c) =>
  (Math.min(255, Math.max(0, Math.round(c[0]))) << 16) |
  (Math.min(255, Math.max(0, Math.round(c[1]))) << 8) |
  Math.min(255, Math.max(0, Math.round(c[2])));
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
export class GhostScene {
  constructor(cols, rows) {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 80 ||
      cols > 320 ||
      rows < 30 ||
      rows > 100
    )
      throw new Error('Unsupported ghost grid');
    this.cols = cols;
    this.rows = rows;
    this.height = rows * 2;
    this.pixels = new Float32Array(cols * this.height * 3);
    this.chars = new Array(cols * rows).fill('');
    this.ink = new Uint32Array(cols * rows);
    this.stars = Array.from({ length: 1600 }, (_, i) => [
      hash(i * 3) * 2 - 1,
      hash(i * 3 + 1) * 2 - 1,
      hash(i * 3 + 2),
    ]);
    this.trail = Array.from({ length: 15 }, () => [cols * 0.57, this.height * 0.43]);
    this.ghost = [cols * 0.57, this.height * 0.43];
    this.lastTime = 0;
  }
  add(x, y, r, color, alpha = 1) {
    const { cols, height, pixels } = this;
    const x0 = Math.max(0, Math.floor(x - r)),
      x1 = Math.min(cols - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)),
      y1 = Math.min(height - 1, Math.ceil(y + r));
    for (let py = y0; py <= y1; py++)
      for (let px = x0; px <= x1; px++) {
        const d = ((px - x) ** 2 + (py - y) ** 2) / (r * r);
        if (d > 1) continue;
        const k = (1 - d) ** 2 * alpha,
          ix = (py * cols + px) * 3;
        for (let c = 0; c < 3; c++) pixels[ix + c] += color[c] * k;
      }
  }
  text(x, y, text, color, opacity = 1) {
    if (y < 0 || y >= this.rows) return;
    const foreground = rgb(mix(BG, color, opacity));
    [...text].forEach((char, i) => {
      if (x + i < 0 || x + i >= this.cols) return;
      const ix = y * this.cols + x + i;
      this.chars[ix] = char;
      this.ink[ix] = foreground;
    });
  }
  panel(x, y, w, h, title, opacity) {
    const { pixels, cols } = this;
    for (let py = Math.max(0, y * 2); py < Math.min(this.height, (y + h) * 2); py++)
      for (let px = Math.max(0, x); px < Math.min(cols, x + w); px++) {
        const ix = (py * cols + px) * 3;
        for (let c = 0; c < 3; c++)
          pixels[ix + c] = pixels[ix + c] * (1 - opacity * 0.94) + BG[c] * opacity;
      }
    const dim = [117, 83, 62];
    this.text(x, y, '╭' + '─'.repeat(w - 2) + '╮', dim, opacity);
    this.text(x, y + h - 1, '╰' + '─'.repeat(w - 2) + '╯', dim, opacity);
    for (let r = 1; r < h - 1; r++) {
      this.text(x, y + r, '│', dim, opacity);
      this.text(x + w - 1, y + r, '│', dim, opacity);
    }
    this.text(x + 2, y, ' ' + title + ' ', AMBER, opacity);
  }
  frame(time, input = {}) {
    if (!Number.isFinite(time) || time < 0)
      throw new RangeError('Scene time must be nonnegative and finite');
    const start = performance.now(),
      { cols, rows, height, pixels } = this;
    this.chars.fill('');
    const phase = time,
      scale = cols / 192;
    const orbit = time * 0.43;
    const gx = Number.isFinite(input.x)
      ? input.x * cols
      : cols * 0.57 + Math.sin(time * 0.75) * cols * 0.075;
    const gy = Number.isFinite(input.y)
      ? input.y * height
      : height * 0.39 + Math.cos(time * 0.9) * height * 0.07;
    const dt = Math.min(0.1, Math.max(0, time - this.lastTime));
    const move = time < this.lastTime ? 1 : 1 - Math.exp(-dt * 8);
    this.ghost[0] += (gx - this.ghost[0]) * move;
    this.ghost[1] += (gy - this.ghost[1]) * move;
    if (time === 0 || time < this.lastTime) this.ghost = [gx, gy];
    this.lastTime = time;
    this.trail.unshift([...this.ghost]);
    this.trail.length = 15;
    const [cx, cy] = this.ghost;
    // The nebula is computed off the main thread; it is encoded as two half-block pixels per cell.
    for (let y = 0; y < height; y++)
      for (let x = 0; x < cols; x++) {
        const dx = (x - cols * 0.55) / cols,
          dy = (y - height * 0.45) / height;
        const field =
          Math.sin(dx * 11 + time * 0.35) +
          Math.cos(dy * 12 - time * 0.21) +
          Math.sin((dx + dy) * 9 + time * 0.18);
        const halo = Math.max(0, 1 - Math.hypot(dx, dy) * 1.3),
          v = ((field + 3) / 6) * halo;
        const ix = (y * cols + x) * 3;
        pixels[ix] = 12 + v * v * 40;
        pixels[ix + 1] = 8 + v * v * 13;
        pixels[ix + 2] = 6 + v * v * 17;
      }
    // A perspective star tunnel with independent orbiting particles.
    for (let i = 0; i < this.stars.length; i++) {
      const p = this.stars[i],
        z = 0.12 + ((((p[2] - time * 0.065) % 1) + 1) % 1);
      const angle = orbit * 0.15,
        sx = p[0] * Math.cos(angle) - p[1] * Math.sin(angle),
        sy = p[0] * Math.sin(angle) + p[1] * Math.cos(angle);
      const x = cols * 0.56 + (sx * cols * 0.29) / z,
        y = height * 0.46 + (sy * height * 0.38) / z;
      if (x < 0 || x >= cols || y < 0 || y >= height) continue;
      this.add(
        x,
        y,
        Math.max(0.8, 1.7 * scale * (1 - z)),
        i % 5 === 0 ? LILAC : AMBER,
        (1 - z) * 0.62,
      );
    }
    for (let ring = 0; ring < 4; ring++)
      for (let i = 0; i < 240; i++) {
        const angle = (i / 240) * Math.PI * 2 + time * (ring % 2 ? -0.18 : 0.24),
          rad = (19 + ring * 8) * scale;
        const xx = Math.cos(angle) * rad,
          yy = Math.sin(angle) * rad;
        const tilt = orbit * 0.6 + ring * 0.35;
        const x = cols * 0.56 + xx * Math.cos(tilt) - yy * 0.3 * Math.sin(tilt);
        const y = height * 0.43 + xx * Math.sin(tilt) * 0.32 + yy * 0.42 * Math.cos(tilt);
        this.add(
          x,
          y,
          1.05 * scale,
          ring % 2 ? LILAC : AMBER,
          0.2 + 0.45 * Math.sin(angle * 3 + time * 2) ** 12,
        );
      }
    const pulse = Number.isFinite(input.pulse)
      ? Math.max(0, time - input.pulse)
      : phase > 8 && phase < 10
        ? phase - 8
        : 10;
    if (pulse < 2)
      for (let i = 0; i < 200; i++) {
        const a = (i / 200) * Math.PI * 2,
          r = pulse * cols * 0.45;
        this.add(
          cx + Math.cos(a) * r,
          cy + Math.sin(a) * r,
          1.5 * scale,
          LILAC,
          (1 - pulse / 2) * 0.8,
        );
      }
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const [tx, ty] = this.trail[i];
      this.add(tx, ty + 10 * scale, 5 * scale, AMBER, (1 - i / 15) * 0.14);
    }
    this.add(cx, cy, 22 * scale, AMBER, 0.2);
    // Exact website mascot: same eyes, body and alternating tail, enlarged in square cell pixels.
    const ghostScale = 2.15 * scale,
      tail = sprite.tails[Math.floor(time * 6) % 2];
    const mask = [...sprite.body, ...tail];
    const look = Math.max(-1, Math.min(1, (gx - cx) / 12));
    for (let y = 0; y < height; y++)
      for (
        let x = Math.max(0, Math.floor(cx - 18 * scale));
        x < Math.min(cols, Math.ceil(cx + 18 * scale));
        x++
      ) {
        const px = Math.floor((x - cx) / ghostScale + 8),
          py = Math.floor((y - cy) / ghostScale + 8);
        if (px < 0 || px >= 16 || py < 0 || py >= 16 || mask[py][px] === '.') continue;
        const eye =
          py >= 4 &&
          py <= 6 &&
          ((px - look >= 4 && px - look <= 5) || (px - look >= 10 && px - look <= 11));
        const ix = (y * cols + x) * 3;
        const color = eye ? [22, 12, 12] : [255, 244 - py * 0.9, 230 - py * 1.1];
        for (let c = 0; c < 3; c++) pixels[ix + c] = color[c];
      }
    // Panels enter on a staggered schedule and settle on a cell-aligned grid.
    const left = smooth((phase - 1) / 0.7),
      right = smooth((phase - 2.2) / 0.7),
      bottom = smooth((phase - 3.4) / 0.7);
    const lw = Math.floor(cols * 0.24),
      lh = Math.floor(rows * 0.56),
      lx = 2 - Math.round((1 - left) * lw),
      ly = 5;
    if (left > 0) {
      this.panel(lx, ly, lw, lh, 'SIGNAL', left);
      this.text(lx + 3, ly + 3, 'GHOST / ONLINE', [245, 236, 227], left);
      this.text(lx + 3, ly + 5, 'POLTERGEIST ARRAY', LILAC, left);
      for (let r = 0; r < Math.min(8, lh - 12); r++) {
        const k = 0.5 + 0.5 * Math.sin(time * 1.8 + r * 0.72),
          w = Math.floor((lw - 8) * k);
        this.text(
          lx + 3,
          ly + 8 + r,
          ('0' + r).slice(-2) + ' ' + '█'.repeat(w),
          mix(AMBER, LILAC, r / 8),
          left,
        );
      }
      const graphY = ly + lh - 6;
      for (let x = 0; x < lw - 6; x++) {
        const amp = 2 + Math.round(Math.sin(x * 0.4 + time * 2) * 1.7);
        this.text(lx + 3 + x, graphY - amp, '⣿', LILAC, left);
      }
      this.text(lx + 3, ly + lh - 2, 'SYNTHETIC SIGNAL', [140, 114, 96], left);
    }
    const rw = Math.floor(cols * 0.2),
      rh = Math.floor(rows * 0.56),
      rx = cols - rw - 2 + Math.round((1 - right) * rw);
    if (right > 0) {
      this.panel(rx, ly, rw, rh, 'SPECTRUM', right);
      for (let c = 0; c < rw - 6; c++) {
        const bars = Math.floor(
          (rh - 8) *
            (0.25 +
              0.65 * Math.abs(Math.sin(c * 0.21 + time * 1.6) * Math.cos(c * 0.09 - time * 0.5))),
        );
        for (let r = 0; r < bars; r++)
          this.text(rx + 3 + c, ly + rh - 4 - r, '▐', mix(AMBER, LILAC, r / (rh - 8)), right);
      }
      this.text(rx + 3, ly + rh - 2, 'ANSI / TRUECOLOR', [140, 114, 96], right);
    }
    const by = rows - 12 + Math.round((1 - bottom) * 12),
      bw = cols - 4;
    if (bottom > 0) {
      this.panel(2, by, bw, 9, 'EVENT STREAM', bottom);
      const tick = Math.floor(time * 12);
      const events = [
        'ghost entered the reactor',
        'orbit field synchronized',
        'signal arrived on channel 07',
        'spectral pulse propagated',
        'terminal cells updated',
        'worker frame completed',
      ];
      for (let row = 0; row < 6; row++) {
        const n = tick - 5 + row;
        const stamp = `00:${String(Math.floor(Math.max(0, n) / 12)).padStart(2, '0')}.${String((Math.max(0, n) % 12) * 8).padStart(2, '0')}`;
        this.text(5, by + 2 + row, stamp, [140, 114, 96], bottom);
        this.text(18, by + 2 + row, 'INFO', row === 5 ? AMBER : LILAC, bottom);
        this.text(
          25,
          by + 2 + row,
          events[((n % events.length) + events.length) % events.length],
          [227, 204, 181],
          bottom,
        );
      }
    }
    this.text(3, 1, 'WRAITH / GHOST REACTOR', AMBER);
    this.text(cols - 39, 1, 'TRUECOLOR · HALF-BLOCKS · UNICODE', [180, 155, 136]);
    this.text(3, rows - 1, 'MOVE TO STEER · CLICK TO PULSE', [180, 155, 136]);
    this.text(cols - 26, rows - 1, `${cols}×${rows} / ${cols * rows * 2} PIXELS`, AMBER);
    let fg = -1,
      bg = -1,
      sgrChanges = 0;
    const chunks = ['\x1b[?25l\x1b[?7l'];
    for (let y = 0; y < rows; y++) {
      chunks.push(`\x1b[${y + 1};1H`);
      for (let x = 0; x < cols; x++) {
        const ix = (y * 2 * cols + x) * 3,
          cell = y * cols + x;
        const top = rgb([pixels[ix], pixels[ix + 1], pixels[ix + 2]]),
          bix = ix + cols * 3;
        const bottomColor = rgb([pixels[bix], pixels[bix + 1], pixels[bix + 2]]);
        const char = this.chars[cell] || '▀',
          f = this.chars[cell] ? this.ink[cell] : top,
          b = bottomColor;
        if (f !== fg) {
          chunks.push(`\x1b[38;2;${f >>> 16};${(f >>> 8) & 255};${f & 255}m`);
          fg = f;
          sgrChanges++;
        }
        if (b !== bg) {
          chunks.push(`\x1b[48;2;${b >>> 16};${(b >>> 8) & 255};${b & 255}m`);
          bg = b;
          sgrChanges++;
        }
        chunks.push(char);
      }
    }
    chunks.push('\x1b[0m');
    const bytes = encoder.encode(chunks.join(''));
    return {
      bytes,
      cols,
      rows,
      pixels: cols * rows * 2,
      particles: this.stars.length + 960,
      generationMs: performance.now() - start,
      sgrChanges,
      phase,
    };
  }
}
