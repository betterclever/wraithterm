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
  constructor(
    document: Document,
    private readonly gpu: Compositor,
    private readonly options: Required<ITerminalOptions>,
    private readonly dpr: number,
    cellWidth: number,
    cellHeight: number,
  ) {
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
    c.fillText(text, 0, this.baseline);
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
