import type { Terminal, IDisposable, ITerminalOptions } from './xterm-api.js';
import init, { Compositor } from '../wasm/wraith_engine.js';
import { BrowserAtlas, AtlasFull } from './xterm-atlas.js';
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
} from './xterm-internals.js';
export type RendererState = 'initializing' | 'webgpu' | 'dom' | 'external';
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
let initialization: Promise<unknown> | undefined;
/** Renderer replacement only: xterm keeps input, parser, scrollback and addons.
 * A retained DOM renderer provides metrics and loss/feature fallback. */
export class XtermRenderer implements Renderer {
  state: RendererState = 'initializing';
  reason: string | undefined;
  private gpu: Compositor | undefined;
  private atlas: BrowserAtlas | undefined;
  private readonly canvas: HTMLCanvasElement;
  private readonly rows: HTMLElement | null;
  private readonly subscriptions: IDisposable[] = [];
  private geometry = '';
  private font = '';
  private full = true;
  private staging = new Uint32Array(0);
  private rects = new Float32Array(0);
  private readonly cell: Cell;
  private readonly view = new Float32Array(4);
  private readonly frame = new Uint32Array(8);
  private disposed = false;
  private fatal = false;
  private hovering = false;
  private blink = true;
  private readonly timer: ReturnType<typeof setInterval>;
  private selectedStart: [number, number] | undefined;
  private selectedEnd: [number, number] | undefined;
  private columnSelection = false;
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
    this.subscriptions.push(
      core.optionsService.onOptionChange(() => this.invalidate()),
      core._themeService.onChangeColors(() => this.invalidate()),
      core.linkifier.onShowLinkUnderline(() => {
        this.hovering = true;
        this.invalidate();
      }),
      core.linkifier.onHideLinkUnderline(() => {
        this.hovering = false;
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
      await initialization;
      if (this.disposed) return false;
      const gpu = await Compositor.create(this.canvas.transferControlToOffscreen());
      if (this.disposed) {
        gpu.free();
        return false;
      }
      this.gpu = gpu;
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
  }
  private fallbackReason(): string | undefined {
    if (this.fatal) return this.reason;
    if (!this.gpu) return 'GPU initialization';
    if (this.terminal.options.allowTransparency) return 'Transparency';
    if (this.terminal.options.minimumContrastRatio !== 1) return 'Minimum contrast adjustment';
    if (this.core._characterJoinerService._characterJoiners.length) return 'Character joiners';
    if (!this.core._decorationService.decorations.next().done) return 'Buffer decorations';
    if (this.hovering) return 'Link hover decorations';
    return undefined;
  }
  renderRows(start: number, end: number): void {
    if (this.disposed) return;
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
      }
      let packed: Uint32Array;
      try {
        packed = this.pack(start, end);
      } catch (error) {
        if (!(error instanceof AtlasFull)) throw error;
        this.atlas!.reset();
        start = 0;
        end = this.terminal.rows - 1;
        packed = this.pack(start, end);
      }
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
      if (!this.gpu!.render(packed, start * this.terminal.cols, this.view, this.frame)) {
        this.invalidate();
        return;
      }
      this.full = false;
      this.reason = undefined;
      this.show(true);
    } catch (error) {
      this.fail(String(error));
      this.fallback.renderRows(0, this.terminal.rows - 1);
    }
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
  private pack(start: number, end: number): Uint32Array {
    const { cols, buffer, options } = this.terminal;
    const b = buffer.active,
      c = this.core._themeService.colors;
    const count = (end - start + 1) * cols * 8;
    if (this.staging.length < count) {
      this.staging = new Uint32Array(this.terminal.rows * cols * 8);
      this.rects = new Float32Array(this.staging.buffer);
    }
    const values = this.staging.subarray(0, count);
    const rects = this.rects;
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
    // Attribute runs are common even when every glyph differs. Keep just the
    // previous decoded style, so RGB churn cannot grow or thrash a style cache.
    let lastFg: number | undefined,
      lastBg: number | undefined,
      cached = false;
    let styleFg = 0,
      styleBg = 0,
      styleUnderline = 0,
      styleFlags = 0,
      underlineDefault = false;
    for (let y = start; y <= end; y++) {
      const line = b.getLine(b.viewportY + y);
      const words = packedRow(line, cols);
      for (let x = 0; x < cols; x++) {
        const i = ((y - start) * cols + x) * 8;
        let content = words?.[x * 3],
          fgWord = words?.[x * 3 + 1],
          bgWord = words?.[x * 3 + 2];
        const direct =
          words !== undefined &&
          !(bgWord! & CELL_HAS_EXTENDED) &&
          !(content! & CELL_IS_COMBINED) &&
          content! >>> 22 <= 2 &&
          (content! & CELL_CODEPOINT_MASK) <= 0x10ffff;
        const data = direct ? undefined : (line?.getCell(x, this.cell) as Cell | undefined);
        if (!direct && !data) {
          values[i] = rgba(c.foreground.rgba);
          values[i + 1] = rgba(c.background.rgba);
          values.fill(0, i + 2, i + 8);
          continue;
        }
        if (!direct) {
          content = data!.content;
          fgWord = data!.fg;
          bgWord = data!.bg;
        }
        const cacheable =
          typeof fgWord === 'number' && typeof bgWord === 'number' && !(bgWord & CELL_HAS_EXTENDED);
        if (!cached || !cacheable || fgWord !== lastFg || bgWord !== lastBg) {
          if (direct) {
            const inverse = !!(fgWord! & 0x4000000);
            styleFg = wordColor(
              inverse ? bgWord! : fgWord!,
              !inverse,
              c,
              !!(fgWord! & 0x8000000) && !!options.drawBoldTextInBrightColors,
            );
            styleBg = wordColor(inverse ? fgWord! : bgWord!, inverse, c, false);
            underlineDefault = !(fgWord! & 0x3000000);
            styleUnderline = underlineDefault ? 0 : wordColor(fgWord!, true, c, false);
            styleFlags =
              ((fgWord! >>> 27) & 1) |
              (((bgWord! >>> 26) & 1) << 1) |
              (((bgWord! >>> 27) & 1) << 2) |
              (((fgWord! >>> 30) & 1) << 4) |
              ((fgWord! >>> 31) << 5) |
              (((bgWord! >>> 30) & 1) << 6) |
              (((fgWord! >>> 28) & 1) << 8);
          } else {
            styleFg = resolveColor(
              data!,
              !data!.isInverse(),
              true,
              c,
              !!options.drawBoldTextInBrightColors,
            );
            styleBg = resolveColor(data!, !!data!.isInverse(), false, c, false);
            underlineDefault = !data!.isUnderlineColorRGB() && !data!.isUnderlineColorPalette();
            styleUnderline = data!.isUnderlineColorRGB()
              ? rgb(data!.getUnderlineColor())
              : data!.isUnderlineColorPalette()
                ? rgba(c.ansi[data!.getUnderlineColor()]!.rgba)
                : 0;
            styleFlags =
              +!!data!.isBold() |
              (+!!data!.isItalic() << 1) |
              (+!!data!.isDim() << 2) |
              (+!!data!.isInvisible() << 4) |
              (+!!data!.isStrikethrough() << 5) |
              (+!!data!.isOverline() << 6) |
              (data!.getUnderlineStyle() << 8);
          }
          lastFg = fgWord;
          lastBg = bgWord;
          cached = cacheable;
        }
        let fg = styleFg,
          bg = styleBg;
        if (hasSelection && this.selected(x, b.viewportY + y)) {
          bg = selectionBackground;
          if (selectionForeground !== undefined) fg = selectionForeground;
        }
        const width = direct ? content! >>> 22 : data!.getWidth();
        const codepoint =
          typeof content === 'number' && !(content & CELL_IS_COMBINED)
            ? content & CELL_CODEPOINT_MASK
            : undefined;
        const bold = !!(styleFlags & 1),
          italic = !!(styleFlags & 2);
        const tile = !width
          ? undefined
          : codepoint !== undefined && codepoint <= 0x10ffff
            ? this.atlas!.scalar(codepoint, bold, italic)
            : this.atlas!.tile(data!.getChars(), bold, italic);
        values[i] = fg;
        values[i + 1] = bg;
        values[i + 2] = underlineDefault ? fg : styleUnderline;
        values[i + 3] = styleFlags | ((width === 2 ? 1 : 0) << 16) | (+!!tile?.colored << 19);
        if (tile) {
          rects[i + 4] = tile.x;
          rects[i + 5] = tile.y;
          rects[i + 6] = tile.width;
          rects[i + 7] = tile.height;
        } else {
          // Blank and wide continuation cells must overwrite the last glyph.
          // Populated cells already write every word, so avoid clearing the
          // entire staging buffer before packing each frame.
          values[i + 4] = 0;
          values[i + 5] = 0;
          values[i + 6] = 0;
          values[i + 7] = 0;
        }
      }
    }
    return values;
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
    this.selectedStart = start;
    this.selectedEnd = end;
    this.columnSelection = column;
    this.fallback.handleSelectionChanged(start, end, column);
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
    for (const subscription of this.subscriptions) subscription.dispose();
    this.gpu?.free();
    this.canvas.remove();
    this.fallback.dispose();
  }
}
