/**
 * Contrast stepping follows xterm.js Color.ts (MIT):
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * See the preserved upstream license in licenses/xterm-MIT.txt.
 * Colors here use the compositor's 0x00bbggrr packing.
 */
const linear = Float64Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
});
export const luminance = (color: number): number =>
  linear[color & 255]! * 0.2126 +
  linear[(color >>> 8) & 255]! * 0.7152 +
  linear[(color >>> 16) & 255]! * 0.0722;
const contrast = (a: number, b: number) =>
  a < b ? (b + 0.05) / (a + 0.05) : (a + 0.05) / (b + 0.05);
export function backgroundGlyph(code: number): boolean {
  return (code >= 0x2500 && code <= 0x259f) || (code >= 0xe0a4 && code <= 0xe0d6);
}
export function adjustContrast(fg: number, bg: number, ratio: number): number | undefined {
  const bgL = luminance(bg),
    fgL = luminance(fg);
  if (contrast(bgL, fgL) >= ratio) return undefined;
  const step = (increase: boolean) => {
    let r = fg & 255,
      g = (fg >>> 8) & 255,
      b = (fg >>> 16) & 255;
    let color = fg;
    while (
      contrast(bgL, luminance(color)) < ratio &&
      (increase ? r < 255 || g < 255 || b < 255 : r > 0 || g > 0 || b > 0)
    ) {
      if (increase) {
        r = Math.min(255, r + Math.ceil((255 - r) * 0.1));
        g = Math.min(255, g + Math.ceil((255 - g) * 0.1));
        b = Math.min(255, b + Math.ceil((255 - b) * 0.1));
      } else {
        r -= Math.ceil(r * 0.1);
        g -= Math.ceil(g * 0.1);
        b -= Math.ceil(b * 0.1);
      }
      color = r | (g << 8) | (b << 16);
    }
    return color;
  };
  const first = step(fgL >= bgL);
  if (contrast(bgL, luminance(first)) >= ratio) return first;
  const second = step(fgL < bgL);
  return contrast(bgL, luminance(first)) > contrast(bgL, luminance(second)) ? first : second;
}
/** Bound color churn independently from the glyph atlas. Ratio changes invalidate
 * both dim/normal caches; palette/theme changes naturally change the RGB keys. */
export class ContrastCache {
  private readonly normal = new Map<number, number>();
  private readonly dim = new Map<number, number>();
  private ratio = 1;
  constructor(private readonly capacity = 4096) {}
  configure(ratio: number): void {
    if (this.ratio === ratio) return;
    this.ratio = ratio;
    this.normal.clear();
    this.dim.clear();
  }
  get size(): number {
    return this.normal.size + this.dim.size;
  }
  resolve(fg: number, bg: number, dim: boolean): number | undefined {
    fg &= 0xffffff;
    bg &= 0xffffff;
    const cache = dim ? this.dim : this.normal;
    const key = fg * 0x1000000 + bg;
    const previous = cache.get(key);
    if (previous !== undefined) return previous < 0 ? undefined : previous;
    const color = adjustContrast(fg, bg, this.ratio / (dim ? 2 : 1));
    if (cache.size >= this.capacity) cache.clear();
    cache.set(key, color ?? -1);
    return color;
  }
}
