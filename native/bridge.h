#ifndef WRAITH_BRIDGE_H
#define WRAITH_BRIDGE_H
#include <stdint.h>
#include <stddef.h>
typedef struct WraithBridge WraithBridge;
typedef struct {
  uint32_t cols, rows, cursor_x, cursor_y, cursor_style, cursor_visible,
      cursor_blink, background, foreground, cursor_color, held;
} WraithFrame;
WraithBridge* wraith_bridge_new(void* user, uint16_t cols, uint16_t rows, size_t history);
void wraith_bridge_free(WraithBridge*);
void wraith_bridge_write(WraithBridge*, const uint8_t*, size_t);
int wraith_bridge_resize(WraithBridge*, uint16_t, uint16_t, uint32_t, uint32_t);
int wraith_bridge_update(WraithBridge*, WraithFrame*);
void wraith_bridge_theme(WraithBridge*, uint32_t, uint32_t, uint32_t);
void wraith_bridge_scroll(WraithBridge*, int32_t);
int wraith_bridge_key(WraithBridge*, uint32_t, uint32_t, uint32_t, const char*, size_t, uint32_t);
int wraith_bridge_mouse(WraithBridge*, uint32_t, uint32_t, uint32_t, float, float, uint32_t);
int wraith_bridge_mode(WraithBridge*, uint16_t);
void wraith_bridge_hold_release(WraithBridge*);
int wraith_bridge_select(WraithBridge*, int32_t, int32_t, int32_t, int32_t);
size_t wraith_bridge_link(WraithBridge*, uint16_t, uint16_t, char*, size_t);
int wraith_bridge_selection_text(WraithBridge*);
#endif
