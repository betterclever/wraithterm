// Minimal PNG reader for Playwright RGB/RGBA screenshots. Test-only, no runtime dependency.
import { inflateSync } from 'node:zlib';
export function pixels(png) {
  let offset = 8,
    width = 0,
    height = 0,
    type = 0;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset),
      kind = png.toString('ascii', offset + 4, offset + 8),
      data = png.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9];
      if (data[8] !== 8 || ![2, 6].includes(type) || data[12] !== 0)
        throw new Error('Unsupported test PNG');
    }
    if (kind === 'IDAT') compressed.push(data);
    offset += 12 + length;
  }
  const bpp = type === 6 ? 4 : 3,
    stride = width * bpp,
    raw = inflateSync(Buffer.concat(compressed)),
    output = Buffer.alloc(width * height * bpp);
  const paeth = (a, b, c) => {
    const p = a + b - c,
      da = Math.abs(p - a),
      db = Math.abs(p - b),
      dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)],
      row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x,
        left = x >= bpp ? output[i - bpp] : 0,
        up = y ? output[i - stride] : 0,
        corner = y && x >= bpp ? output[i - stride - bpp] : 0;
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, corner);
      output[i] = (row[x] + prediction) & 255;
    }
  }
  return { width, height, bpp, data: output };
}
export function pixelSummary(png) {
  const p = pixels(png),
    colors = new Set();
  let bright = 0;
  for (let i = 0; i < p.data.length; i += p.bpp) {
    const r = p.data[i],
      g = p.data[i + 1],
      b = p.data[i + 2];
    colors.add(r | (g << 8) | (b << 16));
    if (r + g + b > 280) bright++;
  }
  return { width: p.width, height: p.height, colors: colors.size, bright };
}
