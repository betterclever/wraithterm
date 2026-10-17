/* Run during both native and Wasm builds. Arbitrary raw cells are safe for
 * these four getters: no pointer, style table or terminal state is accessed. */
#include "ghostty-cell-layout.h"

static int check(GhosttyCell raw) {
  GhosttyCellContentTag tag;
  GhosttyCellWide wide;
  GhosttyStyleId style;
  uint32_t codepoint;
  if (ghostty_cell_get(raw, GHOSTTY_CELL_DATA_CONTENT_TAG, &tag) ||
      ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide) ||
      ghostty_cell_get(raw, GHOSTTY_CELL_DATA_STYLE_ID, &style) ||
      ghostty_cell_get(raw, GHOSTTY_CELL_DATA_CODEPOINT, &codepoint)) return 1;
  return tag != wraith_cell_tag(raw) || wide != wraith_cell_wide(raw) ||
      style != wraith_cell_style(raw) || codepoint != wraith_cell_codepoint(raw);
}

int wraith_test_cell_layout(void) {
  if (check(0) || check(UINT64_MAX)) return 1;
  for (unsigned bit = 0; bit < 64; bit++) {
    uint64_t raw = UINT64_C(1) << bit;
    if (check(raw) || check(~raw)) return 2;
  }
  uint64_t state = UINT64_C(0x6a09e667f3bcc909);
  for (unsigned i = 0; i < 100000; i++) {
    state ^= state << 13; state ^= state >> 7; state ^= state << 17;
    if (check(state)) return 3;
  }
  return 0;
}
#ifndef __wasm__
int main(void) { return wraith_test_cell_layout(); }
#endif
