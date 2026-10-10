import type { ITerminalOptions } from './xterm-api.js';
import type { Compositor } from '../wasm/wraith_engine.js';
export const ATLAS_SIZE = 2048;
export class AtlasFull extends Error {}
export interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
  colored: boolean;
}
/** CSS fonts are rasterized once per glyph/style. Warm frames never touch
 * Canvas2D; Rust owns the GPU texture, cell buffer and render pipeline. */
export class BrowserAtlas {
  private readonly cache = new Map<string, (Tile | undefined)[]>();
  private readonly scalars = new Map<number, (Tile | undefined)[]>();
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
    this.capacity = this.columns * Math.floor(ATLAS_SIZE / this.height);
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
    this.scalars.clear();
  }
  /** Avoid reconstructing and hashing a Unicode string on every warm cell.
   * Both maps reference the same variants; only misses create strings/tiles. */
  scalar(codepoint: number, bold: boolean, italic: boolean): Tile | undefined {
    if (!codepoint || codepoint === 32) return undefined;
    const previous = this.scalars.get(codepoint)?.[+bold | (+italic << 1)];
    if (previous) return previous;
    const text = String.fromCodePoint(codepoint);
    const tile = this.tile(text, bold, italic);
    this.scalars.set(codepoint, this.cache.get(text)!);
    return tile;
  }
  tile(text: string, bold: boolean, italic: boolean): Tile | undefined {
    if (!text || text === ' ') return undefined;
    const style = +bold | (+italic << 1);
    const variants = this.cache.get(text);
    const previous = variants?.[style];
    if (previous) return previous;
    if (this.next >= this.capacity) throw new AtlasFull();
    const c = this.context;
    c.clearRect(0, 0, this.width, this.height);
    c.font = this.font(bold, italic);
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#fff';
    c.fillText(text, 0, this.baseline);
    const pixels = c.getImageData(0, 0, this.width, this.height).data;
    let colored = false;
    for (let i = 0; i < pixels.length; i += 4) {
      if (
        pixels[i + 3]! > 0 &&
        (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255)
      ) {
        colored = true;
        break;
      }
    }
    const tile = {
      x: (this.next % this.columns) * this.width,
      y: Math.floor(this.next / this.columns) * this.height,
      width: this.width,
      height: this.height,
      colored,
    };
    this.gpu.upload(
      tile.x,
      tile.y,
      tile.width,
      tile.height,
      new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    );
    this.next++;
    const stored = variants ?? new Array<Tile | undefined>(4);
    stored[style] = tile;
    if (!variants) this.cache.set(text, stored);
    return tile;
  }
}
