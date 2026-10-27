/* The only file coupled to Ghostty's C ABI. All allocation uses Rust's heap.
 * No terminal-state pointer crosses the JavaScript boundary. */
#include "bridge.h"
#include <ghostty/vt.h>
#include "ghostty-cell-layout.h"
/* Declarations only: libghostty-vt already links Wuffs' PNG decoder. */
#include "wuffs-v0.4.c"

extern void* wraith_alloc(size_t len, uint8_t alignment);
extern void wraith_dealloc(void* ptr, size_t len, uint8_t alignment);
extern void wraith_emit(void* user, uint32_t kind, const uint8_t* data, size_t len);
extern void wraith_row(void* user, uint32_t row);
/* Row reuse: a dirty row whose id, raw cells and selection match a row staged
 * last update is copied by Rust instead of being snapshotted cell by cell. */
extern bool wraith_row_reuse(void* user, uint32_t row, uint64_t id0, uint64_t id1,
                             const uint64_t* raw, size_t len, uint32_t selection);
extern void wraith_row_store(void* user, uint32_t row, uint64_t id0, uint64_t id1,
                             const uint64_t* raw, size_t len, uint32_t selection, bool reusable);
extern void wraith_cell(void* user, uint32_t x, uint32_t y, uint32_t scalar, const uint8_t* text,
                        size_t len, uint32_t fg, uint32_t bg, uint32_t ul, uint32_t flags);
extern void wraith_placement(void* user, const WraithPlacement* placement);
/* One OSC 133 step on the primary screen. `mark` is a tracked grid ref at the
 * cursor (or NULL); Rust owns it from here on and frees it with mark_free. */
extern void wraith_semantic(void* user, uint32_t kind, uint32_t prompt_kind, bool has_exit,
                            int32_t exit_code, const uint8_t* command, size_t len, void* mark);

static void* alloc_fn(void* ctx, size_t n, uint8_t a, uintptr_t r) {
  (void)ctx; (void)r; return wraith_alloc(n, a);
}
static bool resize_fn(void* c, void* p, size_t n, uint8_t a, size_t m, uintptr_t r) {
  (void)c; (void)p; (void)n; (void)a; (void)m; (void)r; return false;
}
static void* remap_fn(void* c, void* p, size_t n, uint8_t a, size_t m, uintptr_t r) {
  (void)c; (void)p; (void)n; (void)a; (void)m; (void)r; return NULL;
}
static void free_fn(void* c, void* p, size_t n, uint8_t a, uintptr_t r) {
  (void)c; (void)r; wraith_dealloc(p, n, a);
}
static const GhosttyAllocatorVtable vtable = {alloc_fn, resize_fn, remap_fn, free_fn};
static const GhosttyAllocator allocator = {NULL, &vtable};

struct WraithBridge {
  void* user;
  GhosttyTerminal terminal;
  GhosttyRenderState render;
  GhosttyRenderStateRowIterator rows;
  GhosttyRenderStateRowCells cells;
  GhosttyKeyEncoder key_encoder;
  GhosttyKeyEvent key_event;
  GhosttyMouseEncoder mouse_encoder;
  GhosttyMouseEvent mouse_event;
  GhosttySearch search;
  GhosttyKittyGraphicsPlacementIterator placements;
  uint32_t cols, height, cw, ch;
  bool held;
  /* Colors the cached rows were resolved with; any change disables reuse. */
  GhosttyColorRgb palette[256], foreground, background;
};

static uint32_t rgb(GhosttyColorRgb c) { return c.r | ((uint32_t)c.g << 8) | ((uint32_t)c.b << 16); }
static GhosttyColorRgb unpack(uint32_t c) { return (GhosttyColorRgb){c & 255, (c >> 8) & 255, (c >> 16) & 255}; }
static GhosttyColorRgb resolve(GhosttyStyleColor c, const GhosttyRenderStateColors* colors, GhosttyColorRgb fallback) {
  if (c.tag == GHOSTTY_STYLE_COLOR_RGB) return c.value.rgb;
  if (c.tag == GHOSTTY_STYLE_COLOR_PALETTE) return colors->palette[c.value.palette];
  return fallback;
}
/* Kitty PNG payloads decode with Wuffs, already linked by libghostty-vt,
 * straight into the RGBA buffer Ghostty will own: pixels are written once.
 * Larger images are rejected before any pixel allocation (16,384 px a side). */
#define WRAITH_IMAGE_SIDE 16384u
static bool decode_png(void* user, const GhosttyAllocator* a, const uint8_t* data, size_t len,
                       GhosttySysImage* out) {
  (void)user;
  size_t decoder_len = sizeof__wuffs_png__decoder(), work_len = 0, bytes = 0;
  wuffs_png__decoder* decoder = wraith_alloc(decoder_len, 3);
  uint8_t *work = NULL, *pixels = NULL;
  bool ok = false;
  if (!decoder) return false;
  wuffs_base__io_buffer source = wuffs_base__ptr_u8__reader((uint8_t*)data, len, true);
  wuffs_base__image_config config;
  wuffs_base__pixel_buffer buffer;
  if (wuffs_png__decoder__initialize(decoder, decoder_len, WUFFS_VERSION, 0).repr ||
      wuffs_png__decoder__decode_image_config(decoder, &config, &source).repr)
    goto done;
  uint32_t w = wuffs_base__pixel_config__width(&config.pixcfg);
  uint32_t h = wuffs_base__pixel_config__height(&config.pixcfg);
  uint64_t work_max = wuffs_png__decoder__workbuf_len(decoder).max_incl;
  if (!w || !h || w > WRAITH_IMAGE_SIDE || h > WRAITH_IMAGE_SIDE || work_max > SIZE_MAX) goto done;
  wuffs_base__pixel_config__set(&config.pixcfg, WUFFS_BASE__PIXEL_FORMAT__RGBA_NONPREMUL,
                                WUFFS_BASE__PIXEL_SUBSAMPLING__NONE, w, h);
  bytes = (size_t)w * h * 4;
  work_len = (size_t)work_max;
  if (work_len && !(work = wraith_alloc(work_len, 3))) goto done;
  if (!(pixels = ghostty_alloc(a, bytes))) goto done;
  if (wuffs_base__pixel_buffer__set_from_slice(&buffer, &config.pixcfg,
                                               wuffs_base__make_slice_u8(pixels, bytes)).repr ||
      wuffs_png__decoder__decode_frame(decoder, &buffer, &source, WUFFS_BASE__PIXEL_BLEND__SRC,
                                       wuffs_base__make_slice_u8(work, work_len), NULL).repr)
    goto done;
  *out = (GhosttySysImage){.width = w, .height = h, .data = pixels, .data_len = bytes};
  ok = true;
done:
  if (!ok && pixels) ghostty_free(a, pixels, bytes);
  if (work) wraith_dealloc(work, work_len, 3);
  wraith_dealloc(decoder, decoder_len, 3);
  return ok;
}
static void on_pty(GhosttyTerminal t, void* user, const uint8_t* p, size_t n) {
  (void)t; WraithBridge* b = user; wraith_emit(b->user, 0, p, n);
}
static void on_bell(GhosttyTerminal t, void* user) {
  (void)t; WraithBridge* b = user; wraith_emit(b->user, 2, NULL, 0);
}
static void on_title(GhosttyTerminal t, void* user) {
  WraithBridge* b = user; GhosttyString text = {0};
  if (ghostty_terminal_get(t, GHOSTTY_TERMINAL_DATA_TITLE, &text) == GHOSTTY_SUCCESS)
    wraith_emit(b->user, 1, (const uint8_t*)text.ptr, text.len);
}
static void on_hold(GhosttyTerminal t, void* user, bool held) {
  (void)t; WraithBridge* b = user; b->held = held;
  wraith_emit(b->user, 3, (const uint8_t*)&held, 1);
}
static bool on_attributes(GhosttyTerminal t, void* user, GhosttyDeviceAttributes* attrs) {
  (void)t; (void)user;
  *attrs = (GhosttyDeviceAttributes){
    .primary = {.conformance_level = 62, .features = {1, 6, 22}, .num_features = 3},
    .secondary = {.device_type = 1, .firmware_version = 100, .rom_cartridge = 0},
    .tertiary = {.unit_id = 0x57524149},
  };
  return true;
}
static GhosttyString on_version(GhosttyTerminal t, void* user) {
  (void)t; (void)user; return (GhosttyString){.ptr = (const uint8_t*)"Wraith 0.1.0", .len = 12};
}
static bool on_size(GhosttyTerminal t, void* user, GhosttySizeReportSize* size) {
  (void)t; WraithBridge* b = user;
  *size = (GhosttySizeReportSize){.rows = b->height, .columns = b->cols,
    .cell_width = b->cw, .cell_height = b->ch};
  return true;
}
/* Ghostty has already applied the step to the screen when this runs, so the
 * cursor is where the step happened. A tracked ref follows that cell through
 * scrolling, pruning and reflow; it reports no value once the row is trimmed.
 * Alternate-screen applications never produce blocks. */
static void on_semantic(GhosttyTerminal t, void* user, const GhosttyTerminalSemanticPrompt* event) {
  WraithBridge* b = user;
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  if (ghostty_terminal_get(t, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen) ||
      screen != GHOSTTY_TERMINAL_SCREEN_PRIMARY)
    return;
  uint16_t x = 0, y = 0;
  ghostty_terminal_get(t, GHOSTTY_TERMINAL_DATA_CURSOR_X, &x);
  ghostty_terminal_get(t, GHOSTTY_TERMINAL_DATA_CURSOR_Y, &y);
  GhosttyPoint point = {.tag = GHOSTTY_POINT_TAG_ACTIVE, .value = {.coordinate = {x, y}}};
  GhosttyTrackedGridRef mark = NULL;
  if (ghostty_terminal_grid_ref_track(t, point, &mark)) mark = NULL;
  wraith_semantic(b->user, event->kind, event->prompt_kind, event->has_exit_code,
                  event->exit_code, event->command.ptr, event->command.len, mark);
}
static bool on_scheme(GhosttyTerminal t, void* user, GhosttyColorScheme* scheme) {
  (void)user; GhosttyColorRgb bg = {0};
  ghostty_terminal_get(t, GHOSTTY_TERMINAL_DATA_COLOR_BACKGROUND, &bg);
  *scheme = (2126u * bg.r + 7152u * bg.g + 722u * bg.b) >= 1280000u
    ? GHOSTTY_COLOR_SCHEME_LIGHT : GHOSTTY_COLOR_SCHEME_DARK;
  return true;
}

WraithBridge* wraith_bridge_new(void* user, uint16_t cols, uint16_t rows, size_t history) {
  WraithBridge* b = wraith_alloc(sizeof(WraithBridge), 3);
  if (!b) return NULL;
  *b = (WraithBridge){.user = user, .cols = cols, .height = rows, .cw = 9, .ch = 18};
  if (ghostty_terminal_new(&allocator, &b->terminal, cols, rows) ||
      ghostty_render_state_new(&allocator, &b->render) ||
      ghostty_render_state_row_iterator_new(&allocator, &b->rows) ||
      ghostty_render_state_row_cells_new(&allocator, &b->cells) ||
      ghostty_key_encoder_new(&allocator, &b->key_encoder) ||
      ghostty_key_event_new(&allocator, &b->key_event) ||
      ghostty_mouse_encoder_new(&allocator, &b->mouse_encoder) ||
      ghostty_mouse_event_new(&allocator, &b->mouse_event) ||
      ghostty_kitty_graphics_placement_iterator_new(&allocator, &b->placements)) {
    wraith_bridge_free(b); return NULL;
  }
  /* Give Ghostty the cell size the bridge reports from creation on: Kitty
   * graphics derive image footprints from it, and a zero size makes every
   * placement occupy no cells until the host's first resize. */
  if (ghostty_terminal_resize(b->terminal, cols, rows, b->cw, b->ch)) {
    wraith_bridge_free(b); return NULL;
  }
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_USERDATA, b);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY, (const void*)on_pty);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_BELL, (const void*)on_bell);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_TITLE_CHANGED, (const void*)on_title);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_RENDER_HOLD, (const void*)on_hold);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES, (const void*)on_attributes);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_XTVERSION, (const void*)on_version);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SIZE, (const void*)on_size);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_COLOR_SCHEME, (const void*)on_scheme);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SEMANTIC_PROMPT, (const void*)on_semantic);
  /* The SDK's history option is a line count. Ghostty defaults to an
   * independent 10,000-byte limit; leaving it enabled silently prunes history
   * long before the requested line count. Zero must use the no-history path. */
  size_t no_history = 0;
  if (ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES,
                           history ? NULL : &no_history) ||
      ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &history)) {
    wraith_bridge_free(b); return NULL;
  }
  /* Browser hosts have no filesystem. Never enable file/shared-memory images. */
  bool disabled = false;
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_FILE, &disabled);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_TEMP_FILE, &disabled);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_SHARED_MEM, &disabled);
  /* Process-wide and idempotent: every terminal decodes PNG through Rust. */
  ghostty_sys_set(GHOSTTY_SYS_OPT_DECODE_PNG, (const void*)decode_png);
  return b;
}
void wraith_bridge_free(WraithBridge* b) {
  if (!b) return;
  ghostty_search_free(b->search);
  ghostty_kitty_graphics_placement_iterator_free(b->placements);
  ghostty_mouse_event_free(b->mouse_event); ghostty_mouse_encoder_free(b->mouse_encoder);
  ghostty_key_event_free(b->key_event); ghostty_key_encoder_free(b->key_encoder);
  ghostty_render_state_row_cells_free(b->cells); ghostty_render_state_row_iterator_free(b->rows);
  ghostty_render_state_free(b->render); ghostty_terminal_free(b->terminal);
  wraith_dealloc(b, sizeof(WraithBridge), 3);
}
void wraith_bridge_write(WraithBridge* b, const uint8_t* p, size_t n) {
  /* The opt-in search cache stores text, never terminal-owned pointers.
   * Invalidate before any content mutation, including resets and pruning. */
  if (b->search && n) ghostty_search_set(b->search, GHOSTTY_SEARCH_OPT_CACHE_PAGES, NULL);
  ghostty_terminal_vt_write(b->terminal, p, n);
}
int wraith_bridge_resize(WraithBridge* b, uint16_t cols, uint16_t rows, uint32_t cw, uint32_t ch) {
  if (b->search) ghostty_search_set(b->search, GHOSTTY_SEARCH_OPT_CACHE_PAGES, NULL);
  uint32_t old_cols = b->cols, old_rows = b->height, old_cw = b->cw, old_ch = b->ch;
  b->cols = cols; b->height = rows; b->cw = cw; b->ch = ch;
  int result = ghostty_terminal_resize(b->terminal, cols, rows, cw, ch);
  if (result) { b->cols = old_cols; b->height = old_rows; b->cw = old_cw; b->ch = old_ch; }
  return result;
}
void wraith_bridge_theme(WraithBridge* b, uint32_t fg, uint32_t bg, uint32_t cursor) {
  GhosttyColorRgb f = unpack(fg), g = unpack(bg), c = unpack(cursor);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &f);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &g);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &c);
}
int wraith_bridge_update(WraithBridge* b, WraithFrame* frame) {
  frame->held = b->held;
  if (b->held) return 0;
  int result = ghostty_render_state_update(b->render, b->terminal);
  if (result) return result;
  GhosttyRenderStateDirty dirty = 0;
  ghostty_render_state_get(b->render, GHOSTTY_RENDER_STATE_DATA_DIRTY, &dirty);
  GhosttyRenderStateColors colors = GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  GhosttyRenderStateCursor cursor = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  ghostty_render_state_get(b->render, GHOSTTY_RENDER_STATE_DATA_COLORS, &colors);
  ghostty_render_state_get(b->render, GHOSTTY_RENDER_STATE_DATA_CURSOR, &cursor);
  frame->cols = b->cols; frame->rows = b->height;
  frame->background = rgb(colors.background); frame->foreground = rgb(colors.foreground);
  frame->cursor_color = rgb(colors.cursor_has_value ? colors.cursor : colors.foreground);
  frame->cursor_visible = cursor.visible && cursor.viewport_has_value;
  frame->cursor_x = cursor.viewport_has_value ? cursor.viewport_x : 0;
  frame->cursor_y = cursor.viewport_has_value ? cursor.viewport_y : 0;
  frame->cursor_style = cursor.visual_style; frame->cursor_blink = cursor.blinking;
  /* Scrolling makes every update a full rebuild (the viewport pin moved), so
   * reuse cannot depend on the dirty level. Its other full-rebuild causes are
   * covered: palette and reverse video change these colors, clears and screen
   * switches change raw cells or row ids, selection is compared per row,
   * resizes reset Rust's keys, and preedit, link hover and glyph registrations
   * are not drawn by this renderer. */
  bool reuse = __builtin_memcmp(b->palette, colors.palette, sizeof(b->palette)) == 0 &&
      __builtin_memcmp(&b->foreground, &colors.foreground, sizeof(GhosttyColorRgb)) == 0 &&
      __builtin_memcmp(&b->background, &colors.background, sizeof(GhosttyColorRgb)) == 0;
  __builtin_memcpy(b->palette, colors.palette, sizeof(b->palette));
  b->foreground = colors.foreground;
  b->background = colors.background;
  ghostty_render_state_get(b->render, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &b->rows);
  uint16_t y;
  while (ghostty_render_state_row_iterator_next_dirty(b->rows, &y)) {
    /* One selection range per row instead of a query per cell. */
    GhosttyRenderStateRowSelection selection = GHOSTTY_INIT_SIZED(GhosttyRenderStateRowSelection);
    bool any_selected = ghostty_render_state_row_get(b->rows, GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION,
                                                     &selection) == GHOSTTY_SUCCESS;
    uint32_t selected_range = any_selected ? selection.start_x | ((uint32_t)selection.end_x << 16) : UINT32_MAX;
    GhosttyRenderStateRowId id = {{0, 0}};
    GhosttyCellsView raw_row = {0};
    bool keyed = ghostty_render_state_row_get(b->rows, GHOSTTY_RENDER_STATE_ROW_DATA_ID, &id) == GHOSTTY_SUCCESS &&
        ghostty_render_state_row_get(b->rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW, &raw_row) == GHOSTTY_SUCCESS &&
        raw_row.len == b->cols;
    const uint64_t* raw_words = (const uint64_t*)raw_row.ptr;
    if (keyed && reuse &&
        wraith_row_reuse(b->user, y, id.bits[0], id.bits[1], raw_words, raw_row.len, selected_range))
      continue;
    bool reusable = keyed;
    wraith_row(b->user, y);
    ghostty_render_state_row_get(b->rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &b->cells);
    /* Style IDs are page-local and every row lies within one page, so a run
     * of equal IDs within a row shares one decoded style. */
    uint32_t style_id = UINT32_MAX, style_flags = 0;
    GhosttyColorRgb style_fg = colors.foreground, style_bg = colors.background, style_ul = {0};
    bool inverse = false, ul_default = true;
    uint32_t x = 0;
    while (x < b->cols) {
      GhosttyCell raw = 0;
      if (keyed) {
        raw = raw_words[x];
      } else {
        if (!ghostty_render_state_row_cells_next(b->cells)) break;
        ghostty_render_state_row_cells_get(b->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
      }
      GhosttyCellContentTag tag = wraith_cell_tag(raw);
      GhosttyCellWide wide = wraith_cell_wide(raw);
      uint32_t codepoint = wraith_cell_codepoint(raw);
      GhosttyStyleId id = wraith_cell_style(raw);
      /* The public raw-row view already contains ordinary cells. Position the
       * iterator only when decoding out-of-line style/grapheme/background data.
       * Keep the iterator fallback if row identity or the bulk view is absent. */
      if (keyed && ((id && id != style_id) ||
          tag == GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE ||
          tag == GHOSTTY_CELL_CONTENT_BG_COLOR_RGB ||
          tag == GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME)) {
        result = ghostty_render_state_row_cells_select(b->cells, (uint16_t)x);
        if (result) return result;
      }
      if (id != style_id) {
        GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
        if (id) ghostty_render_state_row_cells_get(b->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
        style_id = id;
        style_fg = resolve(style.fg_color, &colors, colors.foreground);
        style_bg = resolve(style.bg_color, &colors, colors.background);
        ul_default = style.underline_color.tag == GHOSTTY_STYLE_COLOR_NONE;
        style_ul = resolve(style.underline_color, &colors, colors.foreground);
        inverse = style.inverse;
        style_flags = style.bold | (style.italic << 1) | (style.faint << 2) |
            (style.blink << 3) | (style.invisible << 4) | (style.strikethrough << 5) |
            (style.overline << 6) | ((uint32_t)style.underline << 8);
      }
      GhosttyColorRgb fg = style_fg, bg = style_bg;
      if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE || tag == GHOSTTY_CELL_CONTENT_BG_COLOR_RGB) {
        bg = colors.background;
        ghostty_render_state_row_cells_get(b->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &bg);
      }
      if (inverse) { GhosttyColorRgb temp = fg; fg = bg; bg = temp; }
      uint32_t flags = style_flags |
          ((wide == GHOSTTY_CELL_WIDE_WIDE) << 16) |
          ((wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) << 20) |
          ((any_selected && x >= selection.start_x && x <= selection.end_x) << 17);
      uint8_t scratch[256];
      GhosttyBuffer text = {.ptr = scratch, .cap = sizeof(scratch), .len = 0};
      bool allocated = false;
      uint32_t scalar = 0;
      if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL || wide == GHOSTTY_CELL_WIDE_SPACER_HEAD) {
        /* Continuations draw nothing. */
      } else if (tag == GHOSTTY_CELL_CONTENT_CODEPOINT) {
        scalar = codepoint;
      } else if (tag == GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) {
        /* Grapheme text lives outside the raw cell; never reuse such rows. */
        reusable = false;
        result = ghostty_render_state_row_cells_get(b->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &text);
        if (result == GHOSTTY_OUT_OF_SPACE) {
          text.cap = text.len; text.ptr = wraith_alloc(text.cap, 0); allocated = true;
          if (!text.ptr) return GHOSTTY_OUT_OF_MEMORY;
          result = ghostty_render_state_row_cells_get(b->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &text);
        }
        if (result) { if (allocated) wraith_dealloc(text.ptr, text.cap, 0); return result; }
      }
      wraith_cell(b->user, x++, y, scalar, text.ptr, text.len, rgb(fg), rgb(bg),
                  ul_default ? rgb(fg) : rgb(style_ul), flags);
      if (allocated) wraith_dealloc(text.ptr, text.cap, 0);
    }
    wraith_row_store(b->user, y, id.bits[0], id.bits[1], keyed ? raw_words : NULL,
                     keyed ? raw_row.len : 0, selected_range, reusable);
  }
  ghostty_render_state_clean(b->render);
  return dirty;
}
void wraith_bridge_scroll(WraithBridge* b, int32_t delta) {
  GhosttyTerminalScrollViewport v = {.tag = GHOSTTY_SCROLL_VIEWPORT_DELTA, .value = {.delta = delta}};
  ghostty_terminal_scroll_viewport(b->terminal, v);
}
int wraith_bridge_key(WraithBridge* b, uint32_t key, uint32_t mods, uint32_t action,
                     const char* text, size_t len, uint32_t unshifted) {
  if (key > GHOSTTY_KEY_PASTE || action > GHOSTTY_KEY_ACTION_REPEAT || mods > UINT16_MAX)
    return GHOSTTY_INVALID_VALUE;
  ghostty_key_encoder_setopt_from_terminal(b->key_encoder, b->terminal);
  ghostty_key_event_set_key(b->key_event, key);
  ghostty_key_event_set_mods(b->key_event, mods);
  ghostty_key_event_set_action(b->key_event, action);
  ghostty_key_event_set_utf8(b->key_event, text, len);
  ghostty_key_event_set_unshifted_codepoint(b->key_event, unshifted);
  /* Shift has already been applied to the browser's text payload. */
  ghostty_key_event_set_consumed_mods(b->key_event, len ? mods & GHOSTTY_MODS_SHIFT : 0);
  char output[256]; size_t n = 0;
  int result = ghostty_key_encoder_encode(b->key_encoder, b->key_event, output, sizeof(output), &n);
  if (!result && n) wraith_emit(b->user, 0, (const uint8_t*)output, n);
  return result;
}
int wraith_bridge_mouse(WraithBridge* b, uint32_t action, uint32_t button, uint32_t mods,
                       float x, float y, uint32_t pressed) {
  if (action > GHOSTTY_MOUSE_ACTION_MOTION || button > GHOSTTY_MOUSE_BUTTON_ELEVEN || mods > UINT16_MAX)
    return GHOSTTY_INVALID_VALUE;
  ghostty_mouse_encoder_setopt_from_terminal(b->mouse_encoder, b->terminal);
  GhosttyMouseEncoderSize size = {.size = sizeof(size), .screen_width = b->cols * b->cw,
    .screen_height = b->height * b->ch, .cell_width = b->cw, .cell_height = b->ch};
  bool any = pressed != 0;
  ghostty_mouse_encoder_setopt(b->mouse_encoder, GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &size);
  ghostty_mouse_encoder_setopt(b->mouse_encoder, GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED, &any);
  ghostty_mouse_event_set_action(b->mouse_event, action);
  ghostty_mouse_event_set_mods(b->mouse_event, mods);
  if (button) ghostty_mouse_event_set_button(b->mouse_event, button);
  else ghostty_mouse_event_clear_button(b->mouse_event);
  GhosttyMousePosition pos = {x, y};
  ghostty_mouse_event_set_position(b->mouse_event, pos);
  char output[128]; size_t n = 0;
  int result = ghostty_mouse_encoder_encode(b->mouse_encoder, b->mouse_event, output, sizeof(output), &n);
  if (!result && n) wraith_emit(b->user, 0, (const uint8_t*)output, n);
  return result;
}
int wraith_bridge_mode(WraithBridge* b, uint16_t mode) {
  GhosttyTerminalModeConfig config = {.mode = ghostty_mode_new(mode, false), .value = false};
  ghostty_terminal_get(b->terminal, GHOSTTY_TERMINAL_DATA_MODE, &config);
  return config.value;
}
void wraith_bridge_hold_release(WraithBridge* b) {
  GhosttyTerminalModeConfig config = {.mode = ghostty_mode_new(2026, false), .value = false};
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_MODE, &config);
  b->held = false;
}
int wraith_bridge_select(WraithBridge* b, int32_t x1, int32_t y1, int32_t x2, int32_t y2) {
  return wraith_bridge_select_mode(b, x1, y1, x2, y2, 0);
}
int wraith_bridge_select_mode(WraithBridge* b, int32_t x1, int32_t y1, int32_t x2, int32_t y2, uint32_t mode) {
  if (x1 < 0) return ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, NULL);
  if (mode > 4 || x1 >= b->cols || x2 < 0 || x2 >= b->cols ||
      y1 < 0 || y2 < 0 || y1 >= b->height || y2 >= b->height) return GHOSTTY_INVALID_VALUE;
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  if (mode == 4) {
    int r = ghostty_terminal_select_all(b->terminal, &selection);
    if (r == GHOSTTY_NO_VALUE) return ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, NULL);
    return r ? r : ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, &selection);
  }
  GhosttyGridRef start = GHOSTTY_INIT_SIZED(GhosttyGridRef), end = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyPoint p1 = {.tag = GHOSTTY_POINT_TAG_VIEWPORT, .value = {.coordinate = {x1, y1}}};
  GhosttyPoint p2 = {.tag = GHOSTTY_POINT_TAG_VIEWPORT, .value = {.coordinate = {x2, y2}}};
  int r = ghostty_terminal_grid_ref(b->terminal, p1, &start);
  if (r) return r;
  r = ghostty_terminal_grid_ref(b->terminal, p2, &end); if (r) return r;
  selection.start = start; selection.end = end;
  selection.rectangle = mode == 1;
  if (mode == 2) {
    GhosttyTerminalSelectWordBetweenOptions options = GHOSTTY_INIT_SIZED(GhosttyTerminalSelectWordBetweenOptions);
    GhosttySelection first = GHOSTTY_INIT_SIZED(GhosttySelection), last = GHOSTTY_INIT_SIZED(GhosttySelection);
    options.start = start; options.end = end;
    r = ghostty_terminal_select_word_between(b->terminal, &options, &first);
    if (!r) {
      options.start = end; options.end = start;
      r = ghostty_terminal_select_word_between(b->terminal, &options, &last);
      bool forward = y1 < y2 || (y1 == y2 && x1 <= x2);
      selection.start = forward ? first.start : first.end;
      selection.end = forward ? last.end : last.start;
    }
  } else if (mode == 3) {
    GhosttyTerminalSelectLineOptions options = GHOSTTY_INIT_SIZED(GhosttyTerminalSelectLineOptions);
    GhosttySelection first = GHOSTTY_INIT_SIZED(GhosttySelection), last = GHOSTTY_INIT_SIZED(GhosttySelection);
    options.ref = start;
    r = ghostty_terminal_select_line(b->terminal, &options, &first);
    if (!r) {
      options.ref = end;
      r = ghostty_terminal_select_line(b->terminal, &options, &last);
      bool forward = y1 < y2 || (y1 == y2 && x1 <= x2);
      selection.start = forward ? first.start : first.end;
      selection.end = forward ? last.end : last.start;
    }
  }
  if (r == GHOSTTY_NO_VALUE) return ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, NULL);
  if (r) return r;
  return ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, &selection);
}

/* Search is lazy and advanced in bounded steps between worker messages.
 * Results remain inside Ghostty, where pruning/reflow invalidate tracked refs. */
int wraith_bridge_search(WraithBridge* b, const uint8_t* bytes, size_t len, uint32_t action, uint32_t* output) {
  if (action > 4 || len > 4096) return GHOSTTY_INVALID_VALUE;
  if (!b->search) {
    int r = ghostty_search_new(&allocator, &b->search, b->terminal);
    if (r) return r;
    bool cache = true;
    r = ghostty_search_set(b->search, GHOSTTY_SEARCH_OPT_CACHE_PAGES, &cache);
    if (r) return r;
  }
  int r = GHOSTTY_SUCCESS;
  if (action == 0 || action == 4) {
    GhosttyString needle = {.ptr = bytes, .len = len};
    r = ghostty_search_set(b->search, GHOSTTY_SEARCH_OPT_NEEDLE, action == 4 ? NULL : &needle);
    if (action == 4) ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, NULL);
  } else if (action == 1) {
    r = ghostty_search_feed(b->search);
    GhosttySearchStatus status = GHOSTTY_SEARCH_STATUS_RUNNING;
    for (int i = 0; !r && i < 8 && status == GHOSTTY_SEARCH_STATUS_RUNNING; i++)
      r = ghostty_search_tick(b->search, &status);
  } else {
    r = ghostty_search_set(b->search, action == 2 ? GHOSTTY_SEARCH_OPT_SELECT_NEXT : GHOSTTY_SEARCH_OPT_SELECT_PREV, NULL);
    if (r == GHOSTTY_NO_VALUE) r = GHOSTTY_SUCCESS;
    if (!r) {
      GhosttySelection selected = GHOSTTY_INIT_SIZED(GhosttySelection);
      int found = ghostty_search_get(b->search, GHOSTTY_SEARCH_DATA_SELECTED_MATCH, &selected);
      r = ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, found ? NULL : &selected);
    }
  }
  if (r) return r;
  GhosttySearchStatus status = GHOSTTY_SEARCH_STATUS_COMPLETE;
  size_t total = 0, index = 0;
  ghostty_search_get(b->search, GHOSTTY_SEARCH_DATA_STATUS, &status);
  ghostty_search_get(b->search, GHOSTTY_SEARCH_DATA_TOTAL_MATCHES, &total);
  int found = ghostty_search_get(b->search, GHOSTTY_SEARCH_DATA_SELECTED_INDEX, &index);
  output[0] = status;
  output[1] = total > UINT32_MAX ? UINT32_MAX : (uint32_t)total;
  output[2] = found ? UINT32_MAX : (uint32_t)index;
  return GHOSTTY_SUCCESS;
}
size_t wraith_bridge_link(WraithBridge* b, uint16_t x, uint16_t y, char* out, size_t cap) {
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyPoint p = {.tag = GHOSTTY_POINT_TAG_VIEWPORT, .value = {.coordinate = {x, y}}};
  if (ghostty_terminal_grid_ref(b->terminal, p, &ref)) return 0;
  size_t n = 0;
  if (ghostty_grid_ref_hyperlink_uri(&ref, (uint8_t*)out, cap, &n)) return 0;
  return n;
}
static bool selection_write(void* user, const uint8_t* bytes, size_t len) {
  WraithBridge* b = user; wraith_emit(b->user, 4, bytes, len); return true;
}
static bool range_write(void* user, const uint8_t* bytes, size_t len) {
  WraithBridge* b = user; wraith_emit(b->user, 6, bytes, len); return true;
}
int wraith_bridge_selection_text(WraithBridge* b) {
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  int r = ghostty_terminal_get(b->terminal, GHOSTTY_TERMINAL_DATA_SELECTION, &selection);
  if (r == GHOSTTY_NO_VALUE) return GHOSTTY_SUCCESS;
  if (r) return r;
  GhosttyFormatterTerminalOptions options = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN; options.unwrap = true; options.trim = true;
  options.selection = &selection;
  GhosttyFormatter formatter = NULL;
  r = ghostty_formatter_terminal_new(&allocator, &formatter, b->terminal, options);
  if (r) return r;
  GhosttyWriter writer = {.userdata = b, .write = selection_write};
  r = ghostty_formatter_format(formatter, writer); ghostty_formatter_free(formatter); return r;
}

/* Kitty graphics. Storage is per screen; its generation is zero until an image
 * is ever stored, so terminals without images return before any iteration. */
int wraith_bridge_image_limit(WraithBridge* b, uint64_t bytes) {
  return ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT, &bytes);
}
int wraith_bridge_images(WraithBridge* b, uint64_t* generation) {
  *generation = 0;
  GhosttyKittyGraphics graphics = NULL;
  if (ghostty_terminal_get(b->terminal, GHOSTTY_TERMINAL_DATA_KITTY_GRAPHICS, &graphics) || !graphics)
    return 0;
  ghostty_kitty_graphics_get(graphics, GHOSTTY_KITTY_GRAPHICS_DATA_GENERATION, generation);
  if (!*generation) return 0;
  int r = ghostty_kitty_graphics_get(graphics, GHOSTTY_KITTY_GRAPHICS_DATA_PLACEMENT_ITERATOR, &b->placements);
  if (r) return r;
  int count = 0;
  while (ghostty_kitty_graphics_placement_next(b->placements)) {
    uint32_t image_id = 0, placement_id = 0, x_offset = 0, y_offset = 0;
    bool is_virtual = false; int32_t z = 0;
    ghostty_kitty_graphics_placement_get_multi(b->placements, 6,
        (GhosttyKittyGraphicsPlacementData[]){
          GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_IMAGE_ID,
          GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_PLACEMENT_ID,
          GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_IS_VIRTUAL,
          GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_X_OFFSET,
          GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_Y_OFFSET,
          GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_Z},
        (void*[]){&image_id, &placement_id, &is_virtual, &x_offset, &y_offset, &z}, NULL);
    /* Unicode-placeholder placements are drawn through cells; not supported yet. */
    if (is_virtual) continue;
    GhosttyKittyGraphicsImage image = ghostty_kitty_graphics_image(graphics, image_id);
    if (!image) continue;
    GhosttyKittyGraphicsPlacementRenderInfo info = GHOSTTY_INIT_SIZED(GhosttyKittyGraphicsPlacementRenderInfo);
    if (ghostty_kitty_graphics_placement_render_info(b->placements, image, b->terminal, &info) ||
        !info.viewport_visible || !info.pixel_width || !info.pixel_height ||
        !info.source_width || !info.source_height)
      continue;
    uint64_t image_generation = 0;
    ghostty_kitty_graphics_image_get(image, GHOSTTY_KITTY_IMAGE_DATA_GENERATION, &image_generation);
    WraithPlacement p = {
      .image_id = image_id, .placement_id = placement_id,
      .x = info.viewport_col * (int32_t)b->cw + (int32_t)x_offset,
      .y = info.viewport_row * (int32_t)b->ch + (int32_t)y_offset, .z = z,
      .width = info.pixel_width, .height = info.pixel_height,
      .source_x = info.source_x, .source_y = info.source_y,
      .source_width = info.source_width, .source_height = info.source_height,
      .layer = z < INT32_MIN / 2 ? 1 : z < 0 ? 2 : 3, .generation = image_generation,
    };
    wraith_placement(b->user, &p);
    count++;
  }
  return count;
}
int wraith_bridge_image(WraithBridge* b, uint32_t id, WraithImage* out) {
  GhosttyKittyGraphics graphics = NULL;
  if (ghostty_terminal_get(b->terminal, GHOSTTY_TERMINAL_DATA_KITTY_GRAPHICS, &graphics) || !graphics)
    return GHOSTTY_NO_VALUE;
  GhosttyKittyGraphicsImage image = ghostty_kitty_graphics_image(graphics, id);
  if (!image) return GHOSTTY_NO_VALUE;
  GhosttyKittyImageFormat format = 0;
  *out = (WraithImage){0};
  return ghostty_kitty_graphics_image_get_multi(image, 6,
      (GhosttyKittyGraphicsImageData[]){
        GHOSTTY_KITTY_IMAGE_DATA_WIDTH, GHOSTTY_KITTY_IMAGE_DATA_HEIGHT,
        GHOSTTY_KITTY_IMAGE_DATA_FORMAT, GHOSTTY_KITTY_IMAGE_DATA_DATA_LEN,
        GHOSTTY_KITTY_IMAGE_DATA_GENERATION, GHOSTTY_KITTY_IMAGE_DATA_DATA_PTR},
      (void*[]){&out->width, &out->height, &format, &out->len, &out->generation, &out->data},
      NULL) ? GHOSTTY_NO_VALUE : (out->format = format, GHOSTTY_SUCCESS);
}

/* Command-block marks. `tag` is a GhosttyPointTag. Returns 0 with the point,
 * or 1 when the mark's rows were trimmed or lie outside that coordinate space
 * (for the viewport: above it). */
int wraith_bridge_mark_point(void* mark, uint32_t tag, uint32_t* x, uint32_t* y) {
  GhosttyPointCoordinate c = {0};
  if (!mark || tag > GHOSTTY_POINT_TAG_HISTORY ||
      ghostty_tracked_grid_ref_point((GhosttyTrackedGridRef)mark, tag, &c))
    return 1;
  *x = c.x; *y = c.y; return 0;
}
void wraith_bridge_mark_free(void* mark) { ghostty_tracked_grid_ref_free((GhosttyTrackedGridRef)mark); }
/* Scroll geometry in screen rows: total, viewport offset, viewport length,
 * cursor screen row, cursor column, and whether the primary screen is active. */
int wraith_bridge_screen(WraithBridge* b, uint64_t* out) {
  GhosttyTerminalScrollbar bar = {0};
  int r = ghostty_terminal_get(b->terminal, GHOSTTY_TERMINAL_DATA_SCROLLBAR, &bar);
  if (r) return r;
  uint16_t x = 0, y = 0;
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  ghostty_terminal_get(b->terminal, GHOSTTY_TERMINAL_DATA_CURSOR_X, &x);
  ghostty_terminal_get(b->terminal, GHOSTTY_TERMINAL_DATA_CURSOR_Y, &y);
  ghostty_terminal_get(b->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen);
  out[0] = bar.total; out[1] = bar.offset; out[2] = bar.len;
  out[3] = bar.total - b->height + y; out[4] = x;
  out[5] = screen == GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  return GHOSTTY_SUCCESS;
}
/* Plain text of an inclusive screen-coordinate range, emitted as kind 6. */
int wraith_bridge_range_text(WraithBridge* b, uint32_t x1, uint32_t y1, uint32_t x2, uint32_t y2) {
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  GhosttyGridRef start = GHOSTTY_INIT_SIZED(GhosttyGridRef), end = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyPoint p1 = {.tag = GHOSTTY_POINT_TAG_SCREEN, .value = {.coordinate = {(uint16_t)x1, y1}}};
  GhosttyPoint p2 = {.tag = GHOSTTY_POINT_TAG_SCREEN, .value = {.coordinate = {(uint16_t)x2, y2}}};
  int r = ghostty_terminal_grid_ref(b->terminal, p1, &start);
  if (r) return r;
  r = ghostty_terminal_grid_ref(b->terminal, p2, &end);
  if (r) return r;
  selection.start = start; selection.end = end;
  GhosttyFormatterTerminalOptions options = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN; options.unwrap = true; options.trim = true;
  options.selection = &selection;
  GhosttyFormatter formatter = NULL;
  r = ghostty_formatter_terminal_new(&allocator, &formatter, b->terminal, options);
  if (r) return r;
  GhosttyWriter writer = {.userdata = b, .write = range_write};
  r = ghostty_formatter_format(formatter, writer); ghostty_formatter_free(formatter); return r;
}
void wraith_bridge_scroll_row(WraithBridge* b, uint64_t row) {
  GhosttyTerminalScrollViewport v = {.tag = GHOSTTY_SCROLL_VIEWPORT_ROW, .value = {.row = (size_t)row}};
  ghostty_terminal_scroll_viewport(b->terminal, v);
}
