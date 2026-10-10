/** The only private xterm 6.0 renderer integration surface. Keep the runtime
 * dependency pinned and test this boundary before upgrading it. Public API
 * compatibility is inherited from upstream, not implemented with these types. */
import type { IDisposable, IEvent, Terminal, IBufferCell, IBufferLine } from './xterm-api.js';
export interface Dimensions {
  css: { canvas: { width: number; height: number }; cell: { width: number; height: number } };
  device: {
    canvas: { width: number; height: number };
    cell: { width: number; height: number };
    char: { width: number; height: number; top: number; left: number };
  };
}
export interface Renderer extends IDisposable {
  readonly dimensions: Dimensions;
  readonly onRequestRedraw: IEvent<{ start: number; end: number }>;
  handleDevicePixelRatioChange(): void;
  handleResize(cols: number, rows: number): void;
  handleCharSizeChanged(): void;
  handleBlur(): void;
  handleFocus(): void;
  handleSelectionChanged(
    start: [number, number] | undefined,
    end: [number, number] | undefined,
    column: boolean,
  ): void;
  handleCursorMove(): void;
  clear(): void;
  renderRows(start: number, end: number): void;
  clearTextureAtlas?(): void;
}
export interface Color {
  rgba: number;
  css: string;
}
export interface Colors {
  foreground: Color;
  background: Color;
  cursor: Color;
  cursorAccent: Color;
  ansi: Color[];
  selectionForeground?: Color;
  selectionBackgroundOpaque: Color;
  selectionInactiveBackgroundOpaque: Color;
}
export interface Cell extends IBufferCell {
  // Optional pinned CellData words permit reuse of decoded attributes across
  // adjacent cells. Missing words and extended attributes use the getters.
  readonly fg?: number;
  readonly bg?: number;
  readonly content?: number;
  getUnderlineStyle(): number;
  getUnderlineColor(): number;
  isUnderlineColorDefault(): boolean;
  isUnderlineColorRGB(): boolean;
  isUnderlineColorPalette(): boolean;
}
export const CELL_HAS_EXTENDED = 0x10000000;
export const CELL_IS_COMBINED = 0x200000;
export const CELL_CODEPOINT_MASK = 0x1fffff;
/** BufferLineApiView and BufferLine storage in the pinned xterm 6 runtime.
 * Reject unfamiliar layouts once per row; its public getters remain usable. */
export function packedRow(line: IBufferLine | undefined, cols: number): Uint32Array | undefined {
  const raw = (line as { _line?: { length?: number; _data?: unknown } } | undefined)?._line;
  const words = raw?._data;
  return words instanceof Uint32Array &&
    raw?.length === line?.length &&
    line!.length >= cols &&
    words.length === line!.length * 3
    ? words
    : undefined;
}
export interface Core {
  screenElement: HTMLElement;
  _renderService: {
    _renderer: { value?: Renderer; clearAndLeak(): Renderer | undefined };
    setRenderer(renderer: Renderer): void;
    refreshRows(start: number, end: number, redraw?: boolean): void;
  };
  _themeService: { colors: Colors; onChangeColors: IEvent<Colors> };
  optionsService: { onOptionChange: IEvent<string> };
  _coreBrowserService: { dpr: number; isFocused: boolean };
  coreService: {
    isCursorHidden: boolean;
    isCursorInitialized: boolean;
    decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean };
  };
  _decorationService: { decorations: IterableIterator<unknown> };
  _characterJoinerService: { _characterJoiners: unknown[] };
  linkifier: {
    onShowLinkUnderline: IEvent<unknown>;
    onHideLinkUnderline: IEvent<unknown>;
  };
}
export function internals(terminal: Terminal): Core | undefined {
  const core = (terminal as unknown as { _core?: Core })._core;
  return core?._renderService?._renderer?.clearAndLeak && core.screenElement ? core : undefined;
}
