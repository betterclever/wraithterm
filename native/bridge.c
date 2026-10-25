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
/* Update the render snapshot even inside a synchronized update, without
 * releasing it: replay verification reads parsed content, not the held frame. */
int wraith_bridge_update_content(WraithBridge* b, WraithFrame* frame) {
  bool held = b->held;
  b->held = false;
  int result = wraith_bridge_update(b, frame);
  b->held = held;
  frame->held = held;
  return result;
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

/* Terminal state as VT sequences for replay keyframes.
 *
 * Ghostty's VT formatter emits palette, modes and tabstops, then the active
 * screen's history and viewport, then scrolling region, keyboard modes, working
 * directory, cursor, style, hyperlink, protection, Kitty keyboard flags and
 * charsets. Replayed into a reset terminal of the same size, three gaps would
 * remain, so the bridge splices the output around the content:
 *  - trailing blank rows are trimmed by the formatter; the bridge appends the
 *    newlines that put the restored content on the same rows;
 *  - rows with no text but styled cells (erased with a background colour) are
 *    formatted as blank; the bridge repaints those viewport rows with ECH;
 *  - autowrap-off and insert modes would change how content replays; the
 *    bridge sets them after the content instead of before it.
 * Inactive screens, saved cursors, titles and Kitty images are not formatter
 * state, so callers must verify a snapshot before trusting it. */
typedef struct { uint8_t* p; size_t len, cap; bool failed; } Buf;
static void buf_put(Buf* o, const void* data, size_t n) {
  if (o->failed || !n) return;
  if (o->len + n > o->cap) {
    size_t cap = o->cap ? o->cap : 4096;
    while (cap < o->len + n) cap *= 2;
    uint8_t* next = wraith_alloc(cap, 0);
    if (!next) { o->failed = true; return; }
    if (o->len) __builtin_memcpy(next, o->p, o->len);
    if (o->p) wraith_dealloc(o->p, o->cap, 0);
    o->p = next; o->cap = cap;
  }
  __builtin_memcpy(o->p + o->len, data, n); o->len += n;
}
static void buf_str(Buf* o, const char* text) { buf_put(o, text, __builtin_strlen(text)); }
static void buf_uint(Buf* o, uint64_t value) {
  char digits[24]; size_t n = 0;
  do { digits[sizeof digits - 1 - n++] = (char)('0' + value % 10); value /= 10; } while (value);
  buf_put(o, digits + sizeof digits - n, n);
}
static void buf_free(Buf* o) { if (o->p) wraith_dealloc(o->p, o->cap, 0); *o = (Buf){0}; }
static bool buf_write(void* user, const uint8_t* bytes, size_t len) {
  Buf* o = user; buf_put(o, bytes, len); return !o->failed;
}
static int format_vt(WraithBridge* b, bool extras, Buf* out) {
  GhosttyFormatterTerminalOptions options = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  options.emit = GHOSTTY_FORMATTER_FORMAT_VT; options.unwrap = true; options.trim = false;
  options.extra.size = sizeof(GhosttyFormatterTerminalExtra);
  options.extra.screen.size = sizeof(GhosttyFormatterScreenExtra);
  if (extras) {
    options.extra.palette = true; options.extra.modes = true; options.extra.scrolling_region = true;
    options.extra.tabstops = true; options.extra.pwd = true; options.extra.keyboard = true;
    options.extra.screen.cursor = true; options.extra.screen.style = true;
    options.extra.screen.hyperlink = true; options.extra.screen.protection = true;
    options.extra.screen.kitty_keyboard = true; options.extra.screen.charsets = true;
  }
  GhosttyFormatter formatter = NULL;
  int r = ghostty_formatter_terminal_new(&allocator, &formatter, b->terminal, options);
  if (r) return r;
  GhosttyWriter writer = {.userdata = out, .write = buf_write};
  r = ghostty_formatter_format(formatter, writer); ghostty_formatter_free(formatter);
  return r ? r : out->failed ? GHOSTTY_OUT_OF_MEMORY : GHOSTTY_SUCCESS;
}
static bool cell_at(WraithBridge* b, GhosttyPointTag tag, uint16_t x, uint32_t y, GhosttyGridRef* ref,
                    GhosttyCell* cell) {
  *ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyPoint p = {.tag = tag, .value = {.coordinate = {x, y}}};
  return !ghostty_terminal_grid_ref(b->terminal, p, ref) && !ghostty_grid_ref_cell(ref, cell);
}
static bool row_has_text(WraithBridge* b, GhosttyPointTag tag, uint32_t y) {
  for (uint16_t x = 0; x < b->cols; x++) {
    GhosttyGridRef ref; GhosttyCell cell; bool text = false;
    if (cell_at(b, tag, x, y, &ref, &cell) && !ghostty_cell_get(cell, GHOSTTY_CELL_DATA_HAS_TEXT, &text) && text)
      return true;
  }
  return false;
}
static void sgr_color(Buf* o, GhosttyStyleColor c, const char* extended) {
  if (c.tag == GHOSTTY_STYLE_COLOR_PALETTE) {
    buf_str(o, ";"); buf_str(o, extended); buf_str(o, ";5;"); buf_uint(o, c.value.palette);
  } else if (c.tag == GHOSTTY_STYLE_COLOR_RGB) {
    buf_str(o, ";"); buf_str(o, extended); buf_str(o, ";2;"); buf_uint(o, c.value.rgb.r);
    buf_str(o, ";"); buf_uint(o, c.value.rgb.g); buf_str(o, ";"); buf_uint(o, c.value.rgb.b);
  }
}
static void sgr(Buf* o, const GhosttyStyle* s) {
  buf_str(o, "\x1b[0");
  if (s->bold) buf_str(o, ";1");
  if (s->faint) buf_str(o, ";2");
  if (s->italic) buf_str(o, ";3");
  if (s->underline) { buf_str(o, ";4:"); buf_uint(o, (uint64_t)s->underline); }
  if (s->blink) buf_str(o, ";5");
  if (s->inverse) buf_str(o, ";7");
  if (s->invisible) buf_str(o, ";8");
  if (s->strikethrough) buf_str(o, ";9");
  if (s->overline) buf_str(o, ";53");
  sgr_color(o, s->fg_color, "38");
  sgr_color(o, s->bg_color, "48");
  sgr_color(o, s->underline_color, "58");
  buf_str(o, "m");
}
static bool same_style(const GhosttyStyle* a, const GhosttyStyle* c) {
  return a->fg_color.tag == c->fg_color.tag && a->fg_color.value._padding == c->fg_color.value._padding &&
         a->bg_color.tag == c->bg_color.tag && a->bg_color.value._padding == c->bg_color.value._padding &&
         a->underline_color.tag == c->underline_color.tag &&
         a->underline_color.value._padding == c->underline_color.value._padding &&
         a->bold == c->bold && a->italic == c->italic && a->faint == c->faint && a->blink == c->blink &&
         a->inverse == c->inverse && a->invisible == c->invisible &&
         a->strikethrough == c->strikethrough && a->overline == c->overline && a->underline == c->underline;
}
/* The visible style of a cell: its interned style, or the background-only
 * content Ghostty stores for cells erased with just a background colour. */
static bool styled_cell(WraithBridge* b, uint16_t x, uint32_t y, GhosttyStyle* style) {
  GhosttyGridRef ref; GhosttyCell cell; GhosttyCellContentTag tag = 0; bool styled = false;
  *style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  if (!cell_at(b, GHOSTTY_POINT_TAG_ACTIVE, x, y, &ref, &cell) ||
      ghostty_cell_get(cell, GHOSTTY_CELL_DATA_CONTENT_TAG, &tag)) return false;
  if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE) {
    GhosttyColorPaletteIndex index = 0;
    if (ghostty_cell_get(cell, GHOSTTY_CELL_DATA_COLOR_PALETTE, &index)) return false;
    style->bg_color.tag = GHOSTTY_STYLE_COLOR_PALETTE; style->bg_color.value.palette = index;
    return true;
  }
  if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_RGB) {
    GhosttyColorRgb rgb = {0};
    if (ghostty_cell_get(cell, GHOSTTY_CELL_DATA_COLOR_RGB, &rgb)) return false;
    style->bg_color.tag = GHOSTTY_STYLE_COLOR_RGB; style->bg_color.value.rgb = rgb;
    return true;
  }
  return !ghostty_cell_get(cell, GHOSTTY_CELL_DATA_HAS_STYLING, &styled) && styled &&
         !ghostty_grid_ref_style(&ref, style);
}
/* Repaint viewport rows that hold styled blank cells but no text. */
static void repaint_styled_blank_rows(WraithBridge* b, Buf* o) {
  bool painted = false;
  for (uint32_t y = 0; y < b->height; y++) {
    if (row_has_text(b, GHOSTTY_POINT_TAG_ACTIVE, y)) continue;
    uint16_t x = 0;
    while (x < b->cols) {
      GhosttyStyle style, next;
      if (!styled_cell(b, x, y, &style)) { x++; continue; }
      uint16_t end = x + 1;
      while (end < b->cols && styled_cell(b, end, y, &next) && same_style(&style, &next)) end++;
      buf_str(o, "\x1b["); buf_uint(o, y + 1); buf_str(o, ";"); buf_uint(o, x + 1); buf_str(o, "H");
      sgr(o, &style);
      buf_str(o, "\x1b["); buf_uint(o, end - x); buf_str(o, "X");
      painted = true; x = end;
    }
  }
  if (painted) buf_str(o, "\x1b[0m");
}
static const uint8_t* find(const uint8_t* hay, size_t n, const char* needle) {
  size_t m = __builtin_strlen(needle);
  for (size_t i = 0; i + m <= n; i++) if (!__builtin_memcmp(hay + i, needle, m)) return hay + i;
  return NULL;
}
int wraith_bridge_snapshot(WraithBridge* b) {
  Buf full = {0}, content = {0}, out = {0};
  int r = format_vt(b, true, &full);
  if (!r) r = format_vt(b, false, &content);
  /* The tabstop extra always ends the pre-content state with CUP home. */
  const uint8_t* home = r ? NULL : find(full.p, full.len, "\x1b[H");
  size_t prefix = home ? (size_t)(home - full.p) + 3 : 0;
  if (!r && (!home || prefix + content.len > full.len ||
             (content.len && __builtin_memcmp(full.p + prefix, content.p, content.len))))
    r = GHOSTTY_INVALID_VALUE;
  if (!r) {
    static const char* deferred[] = {"\x1b[?7l", "\x1b[4h"};
    bool defer[2] = {false, false};
    size_t at = 0;
    while (at < prefix) {
      size_t skip = 0;
      for (int i = 0; i < 2; i++) {
        size_t m = __builtin_strlen(deferred[i]);
        if (at + m <= prefix && !__builtin_memcmp(full.p + at, deferred[i], m)) { defer[i] = true; skip = m; }
      }
      if (skip) { at += skip; continue; }
      buf_put(&out, full.p + at, 1); at++;
    }
    buf_put(&out, content.p, content.len);
    size_t total = 0;
    ghostty_terminal_get(b->terminal, GHOSTTY_TERMINAL_DATA_TOTAL_ROWS, &total);
    int64_t last = -1;
    for (int64_t y = (int64_t)total - 1; y >= 0; y--)
      if (row_has_text(b, GHOSTTY_POINT_TAG_SCREEN, (uint32_t)y)) { last = y; break; }
    /* The content leaves the cursor on its last text row, or row 0 if none. */
    for (int64_t y = (last < 0 ? 0 : last) + 1; y < (int64_t)total; y++) buf_str(&out, "\r\n");
    repaint_styled_blank_rows(b, &out);
    for (int i = 0; i < 2; i++) if (defer[i]) buf_str(&out, deferred[i]);
    buf_put(&out, full.p + prefix + content.len, full.len - prefix - content.len);
    if (out.failed) r = GHOSTTY_OUT_OF_MEMORY;
  }
  if (!r) wraith_emit(b->user, 5, out.p, out.len);
  buf_free(&full); buf_free(&content); buf_free(&out);
  return r;
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
