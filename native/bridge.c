/* The only file coupled to Ghostty's C ABI. All allocation uses Rust's heap.
 * No terminal-state pointer crosses the JavaScript boundary. */
#include "bridge.h"
#include <ghostty/vt.h>

extern void* wraith_alloc(size_t len, uint8_t alignment);
extern void wraith_dealloc(void* ptr, size_t len, uint8_t alignment);
extern void wraith_emit(void* user, uint32_t kind, const uint8_t* data, size_t len);
extern void wraith_row(void* user, uint32_t row);
extern void wraith_cell(void* user, uint32_t x, uint32_t y, uint32_t scalar, const uint8_t* text,
                        size_t len, uint32_t fg, uint32_t bg, uint32_t ul, uint32_t flags);

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
  uint32_t cols, height, cw, ch;
  bool held;
};

static uint32_t rgb(GhosttyColorRgb c) { return c.r | ((uint32_t)c.g << 8) | ((uint32_t)c.b << 16); }
static GhosttyColorRgb unpack(uint32_t c) { return (GhosttyColorRgb){c & 255, (c >> 8) & 255, (c >> 16) & 255}; }
static GhosttyColorRgb resolve(GhosttyStyleColor c, const GhosttyRenderStateColors* colors, GhosttyColorRgb fallback) {
  if (c.tag == GHOSTTY_STYLE_COLOR_RGB) return c.value.rgb;
  if (c.tag == GHOSTTY_STYLE_COLOR_PALETTE) return colors->palette[c.value.palette];
  return fallback;
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
      ghostty_mouse_event_new(&allocator, &b->mouse_event)) {
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
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &history);
  /* Browser hosts have no filesystem. Never enable file/shared-memory images. */
  bool disabled = false;
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_FILE, &disabled);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_TEMP_FILE, &disabled);
  ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_SHARED_MEM, &disabled);
  return b;
}
void wraith_bridge_free(WraithBridge* b) {
  if (!b) return;
  ghostty_mouse_event_free(b->mouse_event); ghostty_mouse_encoder_free(b->mouse_encoder);
  ghostty_key_event_free(b->key_event); ghostty_key_encoder_free(b->key_encoder);
  ghostty_render_state_row_cells_free(b->cells); ghostty_render_state_row_iterator_free(b->rows);
  ghostty_render_state_free(b->render); ghostty_terminal_free(b->terminal);
  wraith_dealloc(b, sizeof(WraithBridge), 3);
}
void wraith_bridge_write(WraithBridge* b, const uint8_t* p, size_t n) {
  ghostty_terminal_vt_write(b->terminal, p, n);
}
int wraith_bridge_resize(WraithBridge* b, uint16_t cols, uint16_t rows, uint32_t cw, uint32_t ch) {
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
  ghostty_render_state_get(b->render, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &b->rows);
  static const GhosttyCellData keys[] = {GHOSTTY_CELL_DATA_CONTENT_TAG, GHOSTTY_CELL_DATA_WIDE,
                                         GHOSTTY_CELL_DATA_CODEPOINT, GHOSTTY_CELL_DATA_STYLE_ID};
  uint16_t y;
  while (ghostty_render_state_row_iterator_next_dirty(b->rows, &y)) {
    wraith_row(b->user, y);
    ghostty_render_state_row_get(b->rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &b->cells);
    /* One selection range per row instead of a query per cell. */
    GhosttyRenderStateRowSelection selection = GHOSTTY_INIT_SIZED(GhosttyRenderStateRowSelection);
    bool any_selected = ghostty_render_state_row_get(b->rows, GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION,
                                                     &selection) == GHOSTTY_SUCCESS;
    /* Style IDs are page-local and every row lies within one page, so a run
     * of equal IDs within a row shares one decoded style. */
    uint32_t style_id = UINT32_MAX, style_flags = 0;
    GhosttyColorRgb style_fg = colors.foreground, style_bg = colors.background, style_ul = {0};
    bool inverse = false, ul_default = true;
    uint32_t x = 0;
    while (ghostty_render_state_row_cells_next(b->cells)) {
      GhosttyCell raw = 0;
      ghostty_render_state_row_cells_get(b->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
      GhosttyCellContentTag tag = 0;
      GhosttyCellWide wide = 0;
      uint32_t codepoint = 0;
      GhosttyStyleId id = 0;
      void* values[] = {&tag, &wide, &codepoint, &id};
      ghostty_cell_get_multi(raw, 4, keys, values, NULL);
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
  if (x1 < 0) return ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, NULL);
  GhosttyGridRef start = GHOSTTY_INIT_SIZED(GhosttyGridRef), end = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyPoint p1 = {.tag = GHOSTTY_POINT_TAG_VIEWPORT, .value = {.coordinate = {x1, y1}}};
  GhosttyPoint p2 = {.tag = GHOSTTY_POINT_TAG_VIEWPORT, .value = {.coordinate = {x2, y2}}};
  int r = ghostty_terminal_grid_ref(b->terminal, p1, &start);
  if (r) return r;
  r = ghostty_terminal_grid_ref(b->terminal, p2, &end); if (r) return r;
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  selection.start = start; selection.end = end;
  return ghostty_terminal_set(b->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, &selection);
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
