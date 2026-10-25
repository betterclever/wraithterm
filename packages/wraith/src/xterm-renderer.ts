import type { Terminal, IDisposable, ITerminalOptions } from './xterm-api.js';
import init, { Compositor, type InitOutput } from '../wasm/wraith_engine.js';
import { EffectsController } from './effects.js';
import { BrowserAtlas, AtlasFull } from './xterm-atlas.js';
import { ContrastCache, backgroundGlyph } from './xterm-contrast.js';
import {
  internals,
  CELL_HAS_EXTENDED,
  CELL_IS_COMBINED,
  CELL_CODEPOINT_MASK,
  packedRow,
  type Core,
  type Renderer,
  type Cell,
  type Colors,
  type LinkUnderline,
  type Decoration,
} from './xterm-internals.js';
export type RendererState = 'initializing' | 'webgpu' | 'dom' | 'external';
/** u32 words per packed GPU cell: fg, bg, underline, flags, glyph. */
export const CELL_WORDS = 5;
/** Packed per-cell alpha is opt-in; legacy/native 24-bit cells stay opaque. */
const COLOR_ALPHA = 1 << 21;
const rgb = (value: number) => ((value & 255) << 16) | (value & 0xff00) | ((value >>> 16) & 255);
const rgba = (value: number) => rgb(value >>> 8);
function wordColor(word: number, foreground: boolean, colors: Colors, brighten: boolean): number {
  const mode = word & 0x3000000;
  if (mode === 0x3000000) return rgb(word);
  if (mode) {
    const index = word & 255;
    return rgba(colors.ansi[index + (brighten && index < 8 ? 8 : 0)]!.rgba);
  }
  return rgba((foreground ? colors.foreground : colors.background).rgba);
}
function wordAlpha(word: number, foreground: boolean, colors: Colors, brighten: boolean): number {
  const mode = word & 0x3000000;
  if (mode === 0x3000000) return 255;
  if (mode) {
    const index = word & 255;
    return colors.ansi[index + (brighten && index < 8 ? 8 : 0)]!.rgba & 255;
  }
  return (foreground ? colors.foreground : colors.background).rgba & 255;
}
function resolveColor(
  data: Cell,
  foreground: boolean,
  bright: boolean,
  colors: Colors,
  boldBright: boolean,
): number {
  const color = foreground ? data.getFgColor() : data.getBgColor();
  if (foreground ? data.isFgRGB() : data.isBgRGB()) return rgb(color);
  if (foreground ? data.isFgPalette() : data.isBgPalette()) {
    const index = color + (bright && data.isBold() && boldBright && color < 8 ? 8 : 0);
    return rgba(colors.ansi[index]!.rgba);
  }
  return rgba((foreground ? colors.foreground : colors.background).rgba);
}
function sameRow(words: Uint32Array, rows: Uint32Array, offset: number, count: number): boolean {
  for (let i = 0; i < count; i++) if (words[i] !== rows[offset + i]) return false;
  return true;
}
let initialization: Promise<InitOutput> | undefined;
/** Renderer replacement only: xterm keeps input, parser, scrollback and addons.
 * A retained DOM renderer provides metrics and loss/feature fallback. */
export class XtermRenderer implements Renderer {
  state: RendererState = 'initializing';
  reason: string | undefined;
  private gpu: Compositor | undefined;
  private memory: WebAssembly.Memory | undefined;
  private atlas: BrowserAtlas | undefined;
  private readonly canvas: HTMLCanvasElement;
  private readonly rows: HTMLElement | null;
  private readonly subscriptions: IDisposable[] = [];
  private geometry = '';
  private font = '';
  private full = true;
  private staging = new Uint32Array(0);
  /** Raw xterm words (3 per cell) that produced each staged row. Staging
   * mirrors the GPU cell buffer, so a row whose words recur needs no packing:
   * in place it is skipped, after scrolling it is copied within staging. */
  private rowWords = new Uint32Array(0);
  /** 1 while staging row y is exactly the packing of rowWords row y. */
  private rowCached = new Uint8Array(0);
  /** Frame stamp of the last write to each staging row this frame. */
  private rowStamp = new Uint32Array(0);
  private stamp = 0;
  private shift = 1;
  private lastViewportY = 0;
  private readonly cell: Cell;
  private readonly contrast = new ContrastCache();
  private transparency = false;
  private themeAlpha = false;
  private readonly backgroundStyles = new Map<HTMLElement, { value: string; priority: string }>();
  private view = new Float32Array(4);
  private frame = new Uint32Array(8);
  /** Previous logical row backing each visible row, or 0xffffffff for new
   * content. Rust maps these to persistent, independently owned GPU slots. */
  private rowSources = new Uint32Array(0);
  private disposed = false;
  private fatal = false;
  private hovering: LinkUnderline | undefined;
  private blink = true;
  private readonly timer: ReturnType<typeof setInterval>;
  private selectedStart: [number, number] | undefined;
  private selectedEnd: [number, number] | undefined;
  private columnSelection = false;
  /** An asynchronous effect rebuild holds the compositor; frames wait. */
  private effectsBusy = false;
  private animation = 0;
  readonly effects: EffectsController;
  readonly ready: Promise<boolean>;
  get active(): boolean {
    return this.core._renderService._renderer.value === this;
  }
  get dimensions() {
    return this.fallback.dimensions;
  }
  get onRequestRedraw() {
    return this.fallback.onRequestRedraw;
  }
  private constructor(
    private readonly terminal: Terminal,
    private readonly core: Core,
    private readonly fallback: Renderer,
  ) {
    const document = terminal.element!.ownerDocument;
    this.updateThemeAlpha();
    this.cell = terminal.buffer.active.getNullCell() as Cell;
    this.rows = core.screenElement.querySelector('.xterm-rows');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wraith-xterm-webgpu';
    this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      pointerEvents: 'none',
      display: 'none',
    });
    core.screenElement.prepend(this.canvas);
    this.effects = new EffectsController(
      this.canvas,
      () => this.core._coreBrowserService.dpr,
      ({ params, shader }) => this.applyEffects(params, shader),
      (mouse) => this.setEffectMouse(mouse),
      () => {},
    );
    this.subscriptions.push(
      core.optionsService.onOptionChange(() => this.invalidate()),
      core._themeService.onChangeColors(() => {
        this.updateThemeAlpha();
        this.invalidate();
      }),
      core.linkifier.onShowLinkUnderline((range) => {
        this.hovering = { ...range };
        this.invalidate();
      }),
      core.linkifier.onHideLinkUnderline(() => {
        this.hovering = undefined;
        this.invalidate();
      }),
    );
    this.timer = setInterval(() => {
      if (
        !this.disposed &&
        this.state === 'webgpu' &&
        (core.coreService.decPrivateModes.cursorBlink ?? terminal.options.cursorBlink)
      ) {
        this.blink = !this.blink;
        this.invalidate(false);
      }
    }, 600);
    this.ready = this.initialize();
  }
  static install(terminal: Terminal): XtermRenderer | undefined {
    const core = internals(terminal);
    if (!core) return undefined;
    const fallback = core._renderService._renderer.clearAndLeak();
    if (!fallback) return undefined;
    const renderer = new XtermRenderer(terminal, core, fallback);
    core._renderService.setRenderer(renderer);
    return renderer;
  }
  private async initialize(): Promise<boolean> {
    try {
      if (!navigator.gpu || !this.canvas.transferControlToOffscreen)
        throw new Error('WebGPU or OffscreenCanvas is unavailable');
      initialization ??= init();
      const wasm = await initialization;
      if (this.disposed) return false;
      const gpu = await Compositor.create(this.canvas.transferControlToOffscreen());
      if (this.disposed) {
        gpu.free();
        return false;
      }
      this.gpu = gpu;
      this.memory = wasm.memory;
      this.state = 'webgpu';
      this.invalidate();
      return true;
    } catch (error) {
      if (!this.disposed) this.fail(String(error));
      return false;
    }
  }
  private invalidate(full = true): void {
    this.full ||= full;
    if (!this.disposed)
      this.core._renderService.refreshRows(0, full ? this.terminal.rows - 1 : 0, true);
  }
  private fail(reason: string): void {
    this.fatal = true;
    this.reason = reason;
    this.gpu?.free();
    this.gpu = undefined;
    this.atlas = undefined;
    this.show(false);
  }
  private show(gpu: boolean): void {
    this.state = gpu ? 'webgpu' : 'dom';
    this.canvas.style.display = gpu ? 'block' : 'none';
    if (this.rows) this.rows.style.visibility = gpu ? 'hidden' : '';
    // GPU selection colors are resolved per cell; avoid drawing the DOM
    // selection tint twice. Accessibility lives outside this visual layer.
    const selection = this.core.screenElement.querySelector<HTMLElement>('.xterm-selection');
    if (selection) selection.style.visibility = gpu ? 'hidden' : '';
    if (gpu && this.transparency) {
      // The viewport normally paints the theme behind the renderer. Painting
      // it again underneath an alpha canvas would apply the background twice.
      for (const selector of ['.xterm-scrollable-element', '.xterm-viewport']) {
        const element = this.terminal.element?.querySelector<HTMLElement>(selector);
        if (!element) continue;
        const value = element.style.getPropertyValue('background-color');
        const priority = element.style.getPropertyPriority('background-color');
        if (
          !this.backgroundStyles.has(element) ||
          value !== 'transparent' ||
          priority !== 'important'
        ) {
          this.backgroundStyles.set(element, { value, priority });
          element.style.setProperty('background-color', 'transparent', 'important');
        }
      }
    } else this.restoreBackgrounds();
  }
  private restoreBackgrounds(): void {
    if (!this.backgroundStyles.size) return;
    for (const [element, style] of this.backgroundStyles)
      if (style.value) element.style.setProperty('background-color', style.value, style.priority);
      else element.style.removeProperty('background-color');
    this.backgroundStyles.clear();
  }
  private updateThemeAlpha(): void {
    const colors = this.core._themeService.colors;
    this.themeAlpha =
      (colors.foreground.rgba & 255) !== 255 ||
      colors.ansi.some((color) => (color.rgba & 255) !== 255);
  }
  private fallbackReason(): string | undefined {
    if (this.fatal) return this.reason;
    if (!this.gpu) return 'GPU initialization';
    if (this.core._characterJoinerService._characterJoiners.length) return 'Character joiners';
    return undefined;
  }
  private async applyEffects(params: number[], shader?: string): Promise<void> {
    if (!(await this.ready) || !this.gpu || this.state !== 'webgpu')
      throw new Error('GPU effects require the WebGPU renderer');
    this.effectsBusy = true;
    cancelAnimationFrame(this.animation);
    this.animation = 0;
    try {
      await this.gpu.set_effects(new Float32Array(params), shader);
    } finally {
      this.effectsBusy = false;
      this.invalidate();
    }
  }
  private setEffectMouse(mouse: number[]): void {
    if (!this.gpu || this.effectsBusy || this.disposed) return;
    this.gpu.set_effect_mouse(mouse[0]!, mouse[1]!, mouse[2]!, mouse[3]!);
    this.animate();
  }
  /** Drive effect animation frames only while the compositor reports one. */
  private animate(): void {
    if (this.animation || !this.gpu || this.effectsBusy || this.disposed) return;
    if (!this.gpu.animating) return;
    this.animation = requestAnimationFrame(() => {
      this.animation = 0;
      if (!this.gpu || this.effectsBusy || this.disposed || this.state !== 'webgpu') return;
      try {
        this.gpu.animate();
      } catch (error) {
        this.fail(String(error));
        this.fallback.renderRows(0, this.terminal.rows - 1);
        return;
      }
      this.animate();
    });
  }
  renderRows(start: number, end: number): void {
    if (this.disposed) return;
    if (this.effectsBusy) {
      this.full = true;
      return;
    }
    const reason = this.fallbackReason();
    if (reason) {
      if (this.state !== 'dom') {
        this.full = true;
        start = 0;
        end = this.terminal.rows - 1;
      }
      this.reason = reason;
      this.show(false);
      this.fallback.renderRows(start, end);
      return;
    }
    try {
      const d = this.dimensions,
        o = this.terminal.options as Required<ITerminalOptions>;
      if (this.transparency !== !!o.allowTransparency) {
        this.gpu!.set_transparency(!!o.allowTransparency);
        this.transparency = !!o.allowTransparency;
        this.full = true;
      }
      const geometry = `${this.terminal.cols},${this.terminal.rows},${d.device.canvas.width},${d.device.canvas.height}`;
      if (!d.device.cell.width || !d.device.cell.height) return;
      if (geometry !== this.geometry) {
        this.gpu!.configure(
          this.terminal.cols,
          this.terminal.rows,
          Math.round(d.device.canvas.width),
          Math.round(d.device.canvas.height),
        );
        this.canvas.style.width = `${d.css.canvas.width}px`;
        this.canvas.style.height = `${d.css.canvas.height}px`;
        this.geometry = geometry;
        this.full = true;
        const rows = this.terminal.rows;
        this.rowWords = new Uint32Array(rows * this.terminal.cols * 3);
        this.rowCached = new Uint8Array(rows);
        this.rowStamp = new Uint32Array(rows);
      }
      const font = `${o.fontFamily}|${o.fontSize}|${o.fontWeight}|${o.fontWeightBold}|${d.device.cell.width}|${d.device.cell.height}|${this.core._coreBrowserService.dpr}`;
      if (font !== this.font) {
        this.atlas = new BrowserAtlas(
          this.canvas.ownerDocument,
          this.gpu!,
          o,
          this.core._coreBrowserService.dpr,
          d.device.cell.width,
          d.device.cell.height,
        );
        this.font = font;
        this.full = true;
      }
      if (this.full || this.state !== 'webgpu') {
        start = 0;
        end = this.terminal.rows - 1;
        this.rowCached.fill(0);
      }
      try {
        this.pack(start, end);
      } catch (error) {
        if (!(error instanceof AtlasFull)) throw error;
        this.atlas!.reset();
        this.rowCached.fill(0);
        this.pack(0, this.terminal.rows - 1);
      }
      this.visualFeatures();
      const b = this.terminal.buffer.active,
        colors = this.core._themeService.colors;
      const cs = this.core.coreService;
      const focused = this.core._coreBrowserService.isFocused;
      const style = focused
        ? (cs.decPrivateModes.cursorStyle ?? o.cursorStyle)
        : o.cursorInactiveStyle;
      const styles: Record<string, number> = { bar: 0, block: 1, underline: 2, outline: 3 };
      const y = b.baseY + b.cursorY - b.viewportY;
      const visible =
        cs.isCursorInitialized &&
        !cs.isCursorHidden &&
        style !== 'none' &&
        y >= 0 &&
        y < this.terminal.rows &&
        (!focused || !(cs.decPrivateModes.cursorBlink ?? o.cursorBlink) || this.blink);
      this.view[0] = d.device.cell.width;
      this.view[1] = d.device.cell.height;
      this.view[2] = this.atlas!.width;
      this.view[3] = this.atlas!.height;
      this.frame[0] = this.terminal.cols;
      this.frame[1] = this.terminal.rows;
      this.frame[2] = y * this.terminal.cols + Math.min(b.cursorX, this.terminal.cols - 1);
      this.frame[3] = +visible | ((styles[style ?? 'outline'] ?? 3) << 1) | 65536;
      this.frame[4] = rgba(colors.cursor.rgba);
      this.frame[5] = rgba(colors.cursorAccent.rgba);
      this.frame[7] =
        255 | (Math.max(1, Math.round(o.cursorWidth * this.core._coreBrowserService.dpr)) << 8);
      if (!this.gpu!.render_retained()) {
        this.invalidate();
        return;
      }
      this.full = false;
      this.reason = undefined;
      this.show(true);
      this.animate();
    } catch (error) {
      this.fail(String(error));
      this.fallback.renderRows(0, this.terminal.rows - 1);
    }
  }
  private refreshStaging(): void {
    const pointer = this.gpu!.staging_ptr;
    const words = this.gpu!.staging_words;
    const buffer = this.memory!.buffer;
    if (
      this.staging.buffer !== buffer ||
      this.staging.byteOffset !== pointer ||
      this.staging.length !== words
    ) {
      this.staging = new Uint32Array(buffer, pointer, words);
      this.view = new Float32Array(buffer, pointer + words * 4, 4);
      this.frame = new Uint32Array(buffer, pointer + (words + 4) * 4, 8);
      this.rowSources = new Uint32Array(buffer, pointer + (words + 12) * 4, this.terminal.rows);
    }
  }
  /** Apply optional visual work only to newly packed rows. Reused GPU rows
   * already contain it, preserving retention and the ordinary packing path. */
  private visualFeatures(): void {
    const colors = this.core._themeService.colors;
    const ratio = this.terminal.options.minimumContrastRatio ?? 1;
    const contrast = ratio !== 1;
    const alpha = this.themeAlpha || (this.transparency && (colors.background.rgba & 255) !== 255);
    if (!contrast && !alpha) return;
    this.contrast.configure(ratio);
    const { cols, rows, buffer, options } = this.terminal;
    const b = buffer.active,
      values = this.staging;
    let decorations: Map<number, Decoration[]> | undefined;
    if (alpha && b.type === 'normal')
      for (const decoration of this.core._decorationService.decorations) {
        const y = decoration.marker.line - b.viewportY;
        if (y < 0 || y >= rows) continue;
        decorations ??= new Map();
        const list = decorations.get(y);
        if (list) list.push(decoration);
        else decorations.set(y, [decoration]);
      }
    let lastFg = -1,
      lastBg = -1,
      lastDim = false,
      adjusted: number | undefined;
    for (let y = 0; y < rows; y++) {
      if (this.rowSources[y] !== 0xffffffff) continue;
      const row = b.viewportY + y,
        line = b.getLine(row);
      const words = packedRow(line, cols);
      const overlays = decorations?.get(y);
      const selectable = !!(this.selectedStart && this.selectedEnd && this.rowSelected(row));
      const hover = this.hovering;
      const hovered = hover !== undefined && y >= hover.y1 && y <= hover.y2;
      for (let x = 0, i = y * cols * CELL_WORDS; x < cols; x++, i += CELL_WORDS) {
        const p = x * 3,
          content = words?.[p] ?? 0,
          fgWord = words?.[p + 1] ?? 0,
          bgWord = words?.[p + 2] ?? 0;
        // Match the ordinary packer's pinned-layout checks. Extended or
        // combined cells keep the public-getter path for all their attributes.
        const direct =
          words !== undefined &&
          !(bgWord & CELL_HAS_EXTENDED) &&
          !(content & CELL_IS_COMBINED) &&
          content >>> 22 <= 2 &&
          (content & CELL_CODEPOINT_MASK) <= 0x10ffff;
        const data = direct ? undefined : (line?.getCell(x, this.cell) as Cell | undefined);
        if (!direct && !data) continue;
        let fg = values[i]!,
          fgAlpha = 255,
          bgAlpha = 255,
          ulAlpha = 255;
        const bg = values[i + 1]!,
          flags = values[i + 3]!,
          dim = !!(flags & 4);
        if (alpha) {
          const inverse = direct ? !!(fgWord & 0x4000000) : !!data!.isInverse();
          fgAlpha = direct
            ? wordAlpha(
                inverse ? bgWord : fgWord,
                !inverse,
                colors,
                !!(fgWord & 0x8000000) && !!options.drawBoldTextInBrightColors,
              )
            : this.colorAlpha(data!, !inverse, true, colors, !!options.drawBoldTextInBrightColors);
          // Upstream's inverted default foreground uses an opaque background.
          if (inverse && (direct ? !(bgWord & 0x3000000) : data!.isBgDefault())) fgAlpha = 255;
          if (this.transparency)
            bgAlpha = direct
              ? wordAlpha(inverse ? fgWord : bgWord, inverse, colors, false)
              : this.colorAlpha(data!, inverse, false, colors, false);
          let top = false;
          if (overlays)
            for (const d of overlays) {
              const left = d.options.x ?? 0;
              if (
                x < left ||
                x >= left + (d.options.width ?? 1) ||
                (top && d.options.layer !== 'top')
              )
                continue;
              if (d.foregroundColorRGB) fgAlpha = 255;
              if (d.backgroundColorRGB) bgAlpha = 255;
              top = d.options.layer === 'top';
            }
          if (!top && selectable && this.selected(x, row)) {
            bgAlpha = 255;
            if (colors.selectionForeground) fgAlpha = 255;
          }
          ulAlpha = direct
            ? (fgWord & 0x3000000) === 0x3000000
              ? 255
              : fgWord & 0x3000000
                ? colors.ansi[fgWord & 255]!.rgba & 255
                : fgAlpha
            : data!.isUnderlineColorRGB()
              ? 255
              : data!.isUnderlineColorPalette()
                ? colors.ansi[data!.getUnderlineColor()]!.rgba & 255
                : fgAlpha;
        }
        if (
          contrast &&
          (direct ? content >>> 22 : data!.getWidth()) &&
          !backgroundGlyph(direct ? content & CELL_CODEPOINT_MASK : data!.getCode())
        ) {
          if (fg !== lastFg || bg !== lastBg || dim !== lastDim) {
            adjusted = this.contrast.resolve(fg, bg, dim);
            lastFg = fg;
            lastBg = bg;
            lastDim = dim;
          }
          if (adjusted !== undefined) {
            fg = adjusted;
            fgAlpha = 255;
            if (direct ? !(fgWord & 0x3000000) : data!.isUnderlineColorDefault()) {
              values[i + 2] = fg;
              ulAlpha = 255;
            }
          }
        }
        values[i] = fg;
        if (
          hovered &&
          x >= (y === hover.y1 ? hover.x1 : 0) &&
          x < (y === hover.y2 ? hover.x2 : Math.min(hover.cols, cols))
        ) {
          values[i + 2] = fg;
          ulAlpha = fgAlpha;
        }
        if (fgAlpha !== 255 || bgAlpha !== 255 || ulAlpha !== 255) {
          values[i] = fg | (fgAlpha << 24);
          values[i + 1] = bg | (bgAlpha << 24);
          values[i + 2] = values[i + 2]! | (ulAlpha << 24);
          values[i + 3] = flags | COLOR_ALPHA;
        }
      }
    }
  }
  private colorAlpha(
    data: Cell,
    foreground: boolean,
    bright: boolean,
    colors: Colors,
    boldBright: boolean,
  ): number {
    if (foreground ? data.isFgRGB() : data.isBgRGB()) return 255;
    if (foreground ? data.isFgPalette() : data.isBgPalette()) {
      const color = foreground ? data.getFgColor() : data.getBgColor();
      const index = color + (bright && data.isBold() && boldBright && color < 8 ? 8 : 0);
      return colors.ansi[index]!.rgba & 255;
    }
    return (foreground ? colors.foreground : colors.background).rgba & 255;
  }
  private selected(x: number, y: number): boolean {
    const a = this.selectedStart,
      b = this.selectedEnd;
    if (!a || !b) return false;
    if (this.columnSelection)
      return (
        y >= Math.min(a[1], b[1]) &&
        y <= Math.max(a[1], b[1]) &&
        x >= Math.min(a[0], b[0]) &&
        x < Math.max(a[0], b[0])
      );
    return (y > a[1] || (y === a[1] && x >= a[0])) && (y < b[1] || (y === b[1] && x < b[0]));
  }
  /** Bring logical staging rows up to date and record their prior GPU owners. */
  private pack(start: number, end: number): void {
    const { cols, rows, buffer, options } = this.terminal;
    const b = buffer.active,
      c = this.core._themeService.colors,
      atlas = this.atlas!;
    this.refreshStaging();
    if (rows * cols * CELL_WORDS > this.staging.length || end >= rows)
      throw new Error('Packed rows exceed configured staging');
    let values = this.staging;
    const rowWords = this.rowWords,
      cached = this.rowCached,
      stamps = this.rowStamp,
      stamp = (this.stamp = (this.stamp + 1) >>> 0),
      raw = cols * 3,
      packed = cols * CELL_WORDS;
    for (let y = 0; y < rows; y++) this.rowSources[y] = y;
    // Content moves up when the viewport advances, so copy from rows below
    // first; when it moves back, walk upwards so copy sources stay intact.
    const delta = b.viewportY - this.lastViewportY;
    this.lastViewportY = b.viewportY;
    const step = delta < 0 ? -1 : 1;
    let searched = false;
    const hasSelection = !!this.selectedStart && !!this.selectedEnd;
    const selectionBackground = rgba(
      (this.core._coreBrowserService.isFocused
        ? c.selectionBackgroundOpaque
        : c.selectionInactiveBackgroundOpaque
      ).rgba,
    );
    const selectionForeground = c.selectionForeground
      ? rgba(c.selectionForeground.rgba)
      : undefined;
    const brighten = !!options.drawBoldTextInBrightColors;
    // Walk decorations once per frame, never once per ordinary cell. Upstream
    // still owns DOM decoration elements, onRender callbacks and overview rulers.
    let decorations: Map<number, Decoration[]> | undefined;
    if (b.type === 'normal') {
      for (const decoration of this.core._decorationService.decorations) {
        const y = decoration.marker.line - b.viewportY;
        if (y < start || y > end) continue;
        decorations ??= new Map();
        const list = decorations.get(y);
        if (list) list.push(decoration);
        else decorations.set(y, [decoration]);
      }
    }
    // Attribute runs are common even when every glyph differs. Keep just the
    // previous decoded style, so RGB churn cannot grow or thrash a style cache.
    // Words are unsigned, so -1 never matches a real attribute word.
    let lastFg = -1,
      lastBg = -1,
      styleFg = 0,
      styleBg = 0,
      styleUnderline = 0,
      styleFlags = 0;
    rowLoop: for (let y = step > 0 ? start : end; y >= start && y <= end; y += step) {
      const row = b.viewportY + y;
      const line = b.getLine(row);
      const words = packedRow(line, cols);
      const selectable = hasSelection && this.rowSelected(row);
      const overlays = decorations?.get(y);
      const hover = this.hovering;
      const hovered = hover !== undefined && y >= hover.y1 && y <= hover.y2;
      if (words !== undefined && !selectable && !overlays && !hovered) {
        if (cached[y] && sameRow(words, rowWords, y * raw, raw)) continue;
        // Scrolled content: find this row's words among rows staged last
        // frame that have not been overwritten yet, and move them.
        const candidates = [this.shift, delta, 1];
        for (let k = 0; k <= candidates.length; k++) {
          let source = -1;
          if (k < candidates.length) {
            const s = y + candidates[k]!;
            if (s !== y && s >= 0 && s < rows && cached[s] && stamps[s] !== stamp)
              if (sameRow(words, rowWords, s * raw, raw)) source = s;
          } else if (!searched) {
            searched = true;
            for (let s = 0; s < rows && source < 0; s++)
              if (
                s !== y &&
                cached[s] &&
                stamps[s] !== stamp &&
                sameRow(words, rowWords, s * raw, raw)
              )
                source = s;
          }
          if (source < 0) continue;
          values.copyWithin(y * packed, source * packed, (source + 1) * packed);
          rowWords.copyWithin(y * raw, source * raw, (source + 1) * raw);
          cached[y] = 1;
          this.rowSources[y] = source;
          stamps[y] = stamp;
          this.shift = source - y;
          continue rowLoop;
        }
      }
      let direct = words !== undefined && !selectable && !overlays && !hovered;
      for (let x = 0, i = y * packed; x < cols; x++, i += CELL_WORDS) {
        if (words !== undefined) {
          const content = words[x * 3]!,
            fgWord = words[x * 3 + 1]!,
            bgWord = words[x * 3 + 2]!;
          // Ordinary scalar cells decode straight from xterm's row storage.
          // Combined text, extended attributes and unknown widths use getters.
          if (
            !(bgWord & CELL_HAS_EXTENDED) &&
            !(content & CELL_IS_COMBINED) &&
            content >>> 22 <= 2 &&
            (content & CELL_CODEPOINT_MASK) <= 0x10ffff
          ) {
            if (fgWord !== lastFg || bgWord !== lastBg) {
              const inverse = !!(fgWord & 0x4000000);
              styleFg = wordColor(
                inverse ? bgWord : fgWord,
                !inverse,
                c,
                !!(fgWord & 0x8000000) && brighten,
              );
              styleBg = wordColor(inverse ? fgWord : bgWord, inverse, c, false);
              styleUnderline = fgWord & 0x3000000 ? wordColor(fgWord, true, c, false) : -1;
              styleFlags =
                ((fgWord >>> 27) & 1) |
                (((bgWord >>> 26) & 1) << 1) |
                (((bgWord >>> 27) & 1) << 2) |
                (((fgWord >>> 30) & 1) << 4) |
                ((fgWord >>> 31) << 5) |
                (((bgWord >>> 30) & 1) << 6) |
                (((fgWord >>> 28) & 1) << 8);
              lastFg = fgWord;
              lastBg = bgWord;
            }
            let fg = styleFg,
              bg = styleBg;
            if (!overlays && selectable && this.selected(x, row)) {
              bg = selectionBackground;
              if (selectionForeground !== undefined) fg = selectionForeground;
            }
            const width = content >>> 22;
            values[i] = fg;
            values[i + 1] = bg;
            values[i + 2] = styleUnderline < 0 ? fg : styleUnderline;
            values[i + 3] = width === 2 ? styleFlags | 65536 : styleFlags;
            values[i + 4] = width ? atlas.scalar(content & CELL_CODEPOINT_MASK, styleFlags & 3) : 0;
            continue;
          }
        }
        lastFg = lastBg = -1;
        direct = false;
        const data = line?.getCell(x, this.cell) as Cell | undefined;
        if (!data) {
          values[i] = rgba(c.foreground.rgba);
          values[i + 1] = rgba(c.background.rgba);
          values.fill(0, i + 2, i + CELL_WORDS);
          continue;
        }
        let fg = resolveColor(data, !data.isInverse(), true, c, brighten),
          bg = resolveColor(data, !!data.isInverse(), false, c, false);
        const flags =
          +!!data.isBold() |
          (+!!data.isItalic() << 1) |
          (+!!data.isDim() << 2) |
          (+!!data.isInvisible() << 4) |
          (+!!data.isStrikethrough() << 5) |
          (+!!data.isOverline() << 6) |
          (data.getUnderlineStyle() << 8);
        if (!overlays && selectable && this.selected(x, row)) {
          bg = selectionBackground;
          if (selectionForeground !== undefined) fg = selectionForeground;
        }
        const width = data.getWidth();
        const content = data.content;
        values[i] = fg;
        values[i + 1] = bg;
        values[i + 2] = data.isUnderlineColorRGB()
          ? rgb(data.getUnderlineColor())
          : data.isUnderlineColorPalette()
            ? rgba(c.ansi[data.getUnderlineColor()]!.rgba)
            : fg;
        values[i + 3] = width === 2 ? flags | 65536 : flags;
        values[i + 4] = !width
          ? 0
          : typeof content === 'number' &&
              !(content & CELL_IS_COMBINED) &&
              (content & CELL_CODEPOINT_MASK) <= 0x10ffff
            ? atlas.scalar(content & CELL_CODEPOINT_MASK, flags & 3)
            : atlas.tile(data.getChars(), flags & 3);
      }
      if (values.buffer !== this.memory!.buffer) {
        // A cold glyph upload can grow Wasm memory mid-row and detach views.
        // Earlier writes survive at the same addresses; repeat this row with
        // fresh views to replace any writes skipped after detachment.
        this.refreshStaging();
        values = this.staging;
        lastFg = lastBg = -1;
        y -= step;
        continue;
      }
      if (overlays || hovered) {
        for (let x = 0, i = y * packed; x < cols; x++, i += CELL_WORDS) {
          let top = false;
          if (overlays) {
            for (const d of overlays) {
              const left = d.options.x ?? 0;
              if (
                x < left ||
                x >= left + (d.options.width ?? 1) ||
                (top && d.options.layer !== 'top')
              )
                continue;
              if (d.backgroundColorRGB) values[i + 1] = rgba(d.backgroundColorRGB.rgba);
              if (d.foregroundColorRGB) values[i] = rgba(d.foregroundColorRGB.rgba);
              top = d.options.layer === 'top';
            }
            if (!top && selectable && this.selected(x, row)) {
              values[i + 1] = selectionBackground;
              if (selectionForeground !== undefined) values[i] = selectionForeground;
            }
          }
          if (
            hovered &&
            x >= (y === hover.y1 ? hover.x1 : 0) &&
            x < (y === hover.y2 ? hover.x2 : Math.min(hover.cols, cols))
          ) {
            // Link hover overrides underline/strike/overline as upstream's CSS
            // text-decoration shorthand does, using the final foreground.
            values[i + 3] = (values[i + 3]! & ~0x760) | 0x100;
            values[i + 2] = values[i]!;
          }
        }
      }
      // Rows with combined text, extended attributes or selection depend on
      // more than their words; they are always repacked.
      if (direct) rowWords.set(words!.subarray(0, raw), y * raw);
      cached[y] = +direct;
      this.rowSources[y] = 0xffffffff;
      stamps[y] = stamp;
    }
  }
  private rowSelected(row: number): boolean {
    const a = this.selectedStart!,
      b = this.selectedEnd!;
    return row >= Math.min(a[1], b[1]) && row <= Math.max(a[1], b[1]);
  }
  handleDevicePixelRatioChange(): void {
    this.fallback.handleDevicePixelRatioChange();
    this.invalidate();
  }
  handleResize(cols: number, rows: number): void {
    this.fallback.handleResize(cols, rows);
    this.invalidate();
  }
  handleCharSizeChanged(): void {
    this.fallback.handleCharSizeChanged();
    this.invalidate();
  }
  handleBlur(): void {
    this.fallback.handleBlur();
    this.invalidate();
  }
  handleFocus(): void {
    this.blink = true;
    this.fallback.handleFocus();
    this.invalidate();
  }
  handleSelectionChanged(
    start: [number, number] | undefined,
    end: [number, number] | undefined,
    column: boolean,
  ): void {
    this.fallback.handleSelectionChanged(start, end, column);
    const same = (a: [number, number] | undefined, b: [number, number] | undefined) =>
      a === undefined ? b === undefined : b !== undefined && a[0] === b[0] && a[1] === b[1];
    if (
      same(start, this.selectedStart) &&
      same(end, this.selectedEnd) &&
      column === this.columnSelection
    )
      return;
    // SelectionService can reuse/mutate its endpoint arrays. Keep values from
    // the previous notification so those mutations cannot hide a real change.
    this.selectedStart = start && [start[0], start[1]];
    this.selectedEnd = end && [end[0], end[1]];
    this.columnSelection = column;
    this.invalidate();
  }
  handleCursorMove(): void {
    this.blink = true;
    this.fallback.handleCursorMove();
    this.invalidate(false);
  }
  clear(): void {
    this.fallback.clear();
    this.invalidate();
  }
  clearTextureAtlas(): void {
    this.atlas?.reset();
    this.invalidate();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    cancelAnimationFrame(this.animation);
    this.effects.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.restoreBackgrounds();
    this.gpu?.free();
    this.canvas.remove();
    this.fallback.dispose();
  }
}
