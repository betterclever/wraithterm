#ifndef WRAITH_BRIDGE_H
#define WRAITH_BRIDGE_H
#include <stdint.h>
#include <stddef.h>
typedef struct WraithBridge WraithBridge;
typedef struct {
  uint32_t cols, rows, cursor_x, cursor_y, cursor_style, cursor_visible,
      cursor_blink, background, foreground, cursor_color, held;
} WraithFrame;
/* One visible Kitty graphics placement, in viewport pixels. `layer` is 1 below cell
 * backgrounds, 2 below text and 3 above text; `generation` changes whenever the
 * image's pixels do. */
typedef struct {
  uint32_t image_id, placement_id;
  int32_t x, y, z;
  uint32_t width, height, source_x, source_y, source_width, source_height, layer;
  uint64_t generation;
} WraithPlacement;
/* Borrowed, decoded pixels; valid until the terminal is next mutated. */
typedef struct {
  const uint8_t* data;
  size_t len;
  uint32_t width, height, format;
  uint64_t generation;
} WraithImage;
WraithBridge* wraith_bridge_new(void* user, uint16_t cols, uint16_t rows, size_t history);
void wraith_bridge_free(WraithBridge*);
void wraith_bridge_write(WraithBridge*, const uint8_t*, size_t);
int wraith_bridge_resize(WraithBridge*, uint16_t, uint16_t, uint32_t, uint32_t);
int wraith_bridge_update(WraithBridge*, WraithFrame*);
int wraith_bridge_update_content(WraithBridge*, WraithFrame*);
void wraith_bridge_theme(WraithBridge*, uint32_t, uint32_t, uint32_t);
void wraith_bridge_scroll(WraithBridge*, int32_t);
int wraith_bridge_key(WraithBridge*, uint32_t, uint32_t, uint32_t, const char*, size_t, uint32_t);
int wraith_bridge_mouse(WraithBridge*, uint32_t, uint32_t, uint32_t, float, float, uint32_t);
int wraith_bridge_mode(WraithBridge*, uint16_t);
void wraith_bridge_hold_release(WraithBridge*);
int wraith_bridge_select(WraithBridge*, int32_t, int32_t, int32_t, int32_t);
size_t wraith_bridge_link(WraithBridge*, uint16_t, uint16_t, char*, size_t);
int wraith_bridge_selection_text(WraithBridge*);
int wraith_bridge_snapshot(WraithBridge*);
int wraith_bridge_select_mode(WraithBridge*, int32_t, int32_t, int32_t, int32_t, uint32_t);
int wraith_bridge_search(WraithBridge*, const uint8_t*, size_t, uint32_t, uint32_t*);
int wraith_bridge_images(WraithBridge*, uint64_t* generation);
int wraith_bridge_image(WraithBridge*, uint32_t, WraithImage*);
int wraith_bridge_image_limit(WraithBridge*, uint64_t);
#endif
