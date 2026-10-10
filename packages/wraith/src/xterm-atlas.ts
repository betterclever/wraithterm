import type { ITerminalOptions } from './xterm-api.js';
import type { Compositor } from '../wasm/wraith_engine.js';
export const ATLAS_SIZE = 2048;
/** Scalars below this bound resolve through a flat `scalar * 4 + style` table. */
const SCALAR_TABLE = 0x3000;
const MAX_SLOTS = 0xffffe;
export class AtlasFull extends Error {}
/** GPU glyph word: atlas slot + 1 (bits 0..20), ink width in pixels (20..31),
 * color glyph (31). Zero draws no glyph. Matches terminal.wgsl. */
export type Glyph = number;
/** CSS fonts are rasterized once per glyph/style. Warm frames never touch
 * Canvas2D; Rust owns the GPU texture, cell buffer and render pipeline. */
export class BrowserAtlas {
  private readonly cache = new Map<string, Glyph[]>();
  /** Warm scalar lookups index this table directly; zero marks a miss. */
  readonly scalars = new Uint32Array(SCALAR_TABLE * 4);
  private readonly wide = new Map<number, Glyph[]>();
  private readonly context: CanvasRenderingContext2D;
  private next = 0;
  readonly width: number;
  readonly height: number;
  private readonly columns: number;
  private readonly capacity: number;
  private readonly baseline: number;
  private readonly cellWidth: number;
  private readonly cellHeight: number;
  constructor(
    document: Document,
    private readonly gpu: Compositor,
    private readonly options: Required<ITerminalOptions>,
    private readonly dpr: number,
    cellWidth: number,
    cellHeight: number,
  ) {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.width = Math.ceil(cellWidth * 2 + 4);
    this.height = Math.ceil(cellHeight);
    this.columns = Math.floor(ATLAS_SIZE / this.width);
    this.capacity = Math.min(MAX_SLOTS, this.columns * Math.floor(ATLAS_SIZE / this.height));
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !this.capacity) throw new Error('Glyph atlas dimensions are unsupported');
    this.context = context;
    context.font = this.font(false, false);
    const m = context.measureText('M');
    const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
    const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
    this.baseline = Math.round((cellHeight - ascent - descent) / 2 + ascent);
  }
  private font(bold: boolean, italic: boolean): string {
    return `${italic ? 'italic' : 'normal'} ${bold ? this.options.fontWeightBold : this.options.fontWeight} ${this.options.fontSize * this.dpr}px ${this.options.fontFamily}`;
  }
  reset(): void {
    this.next = 0;
    this.cache.clear();
    this.scalars.fill(0);
    this.wide.clear();
  }
  /** Avoid reconstructing and hashing a Unicode string on every warm cell.
   * Misses fall through to the string cache, which owns rasterization. */
  scalar(codepoint: number, style: number): Glyph {
    if (!codepoint || codepoint === 32) return 0;
    if (codepoint < SCALAR_TABLE) {
      const index = codepoint * 4 + style;
      return this.scalars[index] || (this.scalars[index] = this.miss(codepoint, style));
    }
    let variants = this.wide.get(codepoint);
    if (!variants) this.wide.set(codepoint, (variants = [0, 0, 0, 0]));
    return variants[style] || (variants[style] = this.miss(codepoint, style));
  }
  private miss(codepoint: number, style: number): Glyph {
    return this.tile(String.fromCodePoint(codepoint), style);
  }
  /** Block elements and braille are geometry, not type: draw them to fill the cell exactly so
   * neighbours tile without seams at any line height, as the native atlas does. */
  private procedural(text: string): boolean {
    const c = text.codePointAt(0)!;
    if (text.length !== 1 || !((c >= 0x2580 && c <= 0x259f) || (c >= 0x2800 && c <= 0x28ff)))
      return false;
    const g = this.context,
      w = Math.round(this.cellWidth),
      h = Math.round(this.cellHeight);
    // [x0, x1) × [y0, y1) in eighths of the cell, split points rounded once so neighbours meet.
    const fill = (x0: number, y0: number, x1: number, y1: number, alpha = 1) => {
      const px0 = Math.floor((x0 * w + 4) / 8),
        px1 = Math.floor((x1 * w + 4) / 8);
      const py0 = Math.floor((y0 * h + 4) / 8),
        py1 = Math.floor((y1 * h + 4) / 8);
      g.globalAlpha = alpha;
      g.fillRect(px0, py0, px1 - px0, py1 - py0);
      g.globalAlpha = 1;
    };
    if (c === 0x2580) fill(0, 0, 8, 4);
    else if (c <= 0x2587) fill(0, 8 - (c - 0x2580), 8, 8);
    else if (c === 0x2588) fill(0, 0, 8, 8);
    else if (c <= 0x258f) fill(0, 0, 8 - (c - 0x2588), 8);
    else if (c === 0x2590) fill(4, 0, 8, 8);
    else if (c <= 0x2593) fill(0, 0, 8, 8, [64, 128, 191][c - 0x2591]! / 255);
    else if (c === 0x2594) fill(0, 0, 8, 1);
    else if (c === 0x2595) fill(7, 0, 8, 8);
    else if (c <= 0x259f) {
      // Quadrants as bits: 1 upper-left, 2 upper-right, 4 lower-left, 8 lower-right.
      const q = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14][c - 0x2596]!;
      if (q & 1) fill(0, 0, 4, 4);
      if (q & 2) fill(4, 0, 8, 4);
      if (q & 4) fill(0, 4, 4, 8);
      if (q & 8) fill(4, 4, 8, 8);
    } else {
      // Braille: dots 1-3 and 7 down the left column, 4-6 and 8 down the right.
      const dots = [
        [0, 0],
        [0, 1],
        [0, 2],
        [1, 0],
        [1, 1],
        [1, 2],
        [0, 3],
        [1, 3],
      ];
      const sw = w / 2,
        sh = h / 4,
        r = Math.max(1, Math.min(sw, sh) * 0.34);
      dots.forEach(([dx, dy], k) => {
        if (!((c - 0x2800) & (1 << k))) return;
        const cx = (dx! + 0.5) * sw,
          cy = (dy! + 0.5) * sh;
        const x0 = Math.max(0, Math.round(cx - r)),
          x1 = Math.min(w, Math.round(cx + r));
        const y0 = Math.max(0, Math.round(cy - r)),
          y1 = Math.min(h, Math.round(cy + r));
        g.fillRect(x0, y0, x1 - x0, y1 - y0);
      });
    }
    return true;
  }
  tile(text: string, style: number): Glyph {
    if (!text || text === ' ') return 0;
    const variants = this.cache.get(text);
    const previous = variants?.[style];
    if (previous) return previous;
    if (this.next >= this.capacity) throw new AtlasFull();
    const c = this.context;
    c.clearRect(0, 0, this.width, this.height);
    c.font = this.font(!!(style & 1), !!(style & 2));
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#fff';
    if (!this.procedural(text)) c.fillText(text, 0, this.baseline);
    const pixels = c.getImageData(0, 0, this.width, this.height).data;
    let colored = false,
      ink = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (!pixels[i + 3]) continue;
      ink = Math.max(ink, ((i >> 2) % this.width) + 1);
      if (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255) colored = true;
    }
    const slot = this.next++;
    this.gpu.upload(
      (slot % this.columns) * this.width,
      Math.floor(slot / this.columns) * this.height,
      this.width,
      this.height,
      new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    );
    const glyph = ((slot + 1) | (Math.min(ink, 2047) << 20) | (+colored << 31)) >>> 0;
    const stored = variants ?? [0, 0, 0, 0];
    stored[style] = glyph;
    if (!variants) this.cache.set(text, stored);
    return glyph;
  }
}
