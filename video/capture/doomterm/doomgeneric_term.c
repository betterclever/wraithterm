/* doomterm: a doomgeneric platform that is an ordinary terminal program.
 * Frames go to stdout as truecolor half-block text or Kitty graphics; keys come
 * from stdin in raw mode.
 *
 *   DOOMTERM=text|kitty     output mode (default text)
 *   DOOMTERM_COLS / _ROWS   text grid; 320x100 is DOOM's native 320x200
 *   DOOMTERM_SCALE=c,r      kitty placement size in cells (default: terminal-sized)
 *   DOOMTERM_DEMO=1         deterministic game clock (35 Hz tics), no input
 *   DOOMTERM_FRAMES=N       exit after N frames
 */
#include "doomgeneric.h"
#include "doomkeys.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/ioctl.h>

static int kitty, demo, cols = 160, rows = 50, scale_c, scale_r;
static long frames_left = -1;
static uint32_t fake_ms;
static struct termios saved;
static int raw_mode;
static char* out;
static size_t out_cap, out_len;

static void put(const char* s, size_t n) {
  if (out_len + n > out_cap) {
    out_cap = (out_len + n) * 2;
    out = realloc(out, out_cap);
  }
  memcpy(out + out_len, s, n);
  out_len += n;
}
static void puts_(const char* s) { put(s, strlen(s)); }
static void flush_out(void) {
  size_t off = 0;
  while (off < out_len) {
    ssize_t n = write(1, out + off, out_len - off);
    if (n <= 0) break;
    off += (size_t)n;
  }
  out_len = 0;
}
static void restore(void) {
  puts_("\x1b[0m\x1b[?25h");
  if (kitty) puts_("\x1b_Ga=d,d=A,q=2\x1b\\");
  flush_out();
  if (raw_mode) tcsetattr(0, TCSANOW, &saved);
}

void DG_Init(void) {
  const char* mode = getenv("DOOMTERM");
  kitty = mode && !strcmp(mode, "kitty");
  demo = getenv("DOOMTERM_DEMO") != NULL;
  if (getenv("DOOMTERM_FRAMES")) frames_left = atol(getenv("DOOMTERM_FRAMES"));
  if (getenv("DOOMTERM_COLS")) cols = atoi(getenv("DOOMTERM_COLS"));
  if (getenv("DOOMTERM_ROWS")) rows = atoi(getenv("DOOMTERM_ROWS"));
  if (getenv("DOOMTERM_SCALE")) sscanf(getenv("DOOMTERM_SCALE"), "%d,%d", &scale_c, &scale_r);
  if (!demo && isatty(0)) {
    struct winsize ws;
    if (!ioctl(1, TIOCGWINSZ, &ws) && ws.ws_col && ws.ws_row) {
      if (!getenv("DOOMTERM_COLS")) cols = ws.ws_col;
      if (!getenv("DOOMTERM_ROWS")) rows = ws.ws_row;
    }
    tcgetattr(0, &saved);
    struct termios t = saved;
    cfmakeraw(&t);
    tcsetattr(0, TCSANOW, &t);
    fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);
    raw_mode = 1;
  }
  atexit(restore);
  puts_("\x1b[?25l\x1b[2J");
  flush_out();
}

static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void kitty_frame(void) {
  /* RGB at the engine's full 640x400, chunked as clients do. */
  static uint8_t rgb[DOOMGENERIC_RESX * DOOMGENERIC_RESY * 3];
  static char enc[sizeof(rgb) / 3 * 4 + 4];
  for (int i = 0; i < DOOMGENERIC_RESX * DOOMGENERIC_RESY; i++) {
    uint32_t p = DG_ScreenBuffer[i];
    rgb[i * 3] = p >> 16, rgb[i * 3 + 1] = p >> 8, rgb[i * 3 + 2] = p;
  }
  size_t n = 0;
  for (size_t i = 0; i < sizeof(rgb); i += 3) {
    uint32_t v = (uint32_t)rgb[i] << 16 | (uint32_t)rgb[i + 1] << 8 | rgb[i + 2];
    enc[n++] = b64[v >> 18], enc[n++] = b64[v >> 12 & 63], enc[n++] = b64[v >> 6 & 63], enc[n++] = b64[v & 63];
  }
  int c = scale_c ? scale_c : cols, r = scale_r ? scale_r : rows;
  char head[160];
  puts_("\x1b[H");
  for (size_t i = 0; i < n; i += 4096) {
    int more = i + 4096 < n;
    int len = i ? snprintf(head, sizeof head, "\x1b_Gm=%d;", more)
                : snprintf(head, sizeof head, "\x1b_Ga=T,f=24,s=%d,v=%d,i=1,q=2,c=%d,r=%d,C=1,m=%d;",
                           DOOMGENERIC_RESX, DOOMGENERIC_RESY, c, r, more);
    put(head, (size_t)len);
    put(enc + i, more ? 4096 : n - i);
    puts_("\x1b\\");
  }
}
static uint32_t sample(int x0, int y0, int x1, int y1) {
  /* Box-average the 640x400 buffer over [x0,x1) x [y0,y1). */
  uint32_t r = 0, g = 0, b = 0, count = 0;
  for (int y = y0; y < y1; y++)
    for (int x = x0; x < x1; x++) {
      uint32_t p = DG_ScreenBuffer[y * DOOMGENERIC_RESX + x];
      r += p >> 16 & 255, g += p >> 8 & 255, b += p & 255, count++;
    }
  if (!count) return 0;
  return (r / count) << 16 | (g / count) << 8 | (b / count);
}
static void text_frame(void) {
  char sgr[64];
  uint32_t fg = 0xffffffff, bg = 0xffffffff;
  puts_("\x1b[H");
  for (int y = 0; y < rows; y++) {
    if (y) puts_("\r\n");
    for (int x = 0; x < cols; x++) {
      int x0 = x * DOOMGENERIC_RESX / cols, x1 = (x + 1) * DOOMGENERIC_RESX / cols;
      int y0 = 2 * y * DOOMGENERIC_RESY / (2 * rows), ym = (2 * y + 1) * DOOMGENERIC_RESY / (2 * rows),
          y1 = (2 * y + 2) * DOOMGENERIC_RESY / (2 * rows);
      uint32_t top = sample(x0, y0, x1, ym), bottom = sample(x0, ym, x1, y1);
      int len = 0;
      if (top != fg && bottom != bg)
        len = snprintf(sgr, sizeof sgr, "\x1b[38;2;%u;%u;%u;48;2;%u;%u;%um", top >> 16, top >> 8 & 255,
                       top & 255, bottom >> 16, bottom >> 8 & 255, bottom & 255);
      else if (top != fg)
        len = snprintf(sgr, sizeof sgr, "\x1b[38;2;%u;%u;%um", top >> 16, top >> 8 & 255, top & 255);
      else if (bottom != bg)
        len = snprintf(sgr, sizeof sgr, "\x1b[48;2;%u;%u;%um", bottom >> 16, bottom >> 8 & 255, bottom & 255);
      put(sgr, (size_t)len);
      fg = top, bg = bottom;
      puts_("\xe2\x96\x80"); /* U+2580 upper half block */
    }
  }
  puts_("\x1b[0m");
}
void DG_DrawFrame(void) {
  if (kitty) kitty_frame();
  else text_frame();
  flush_out();
  if (frames_left > 0 && --frames_left == 0) exit(0);
}
void DG_SleepMs(uint32_t ms) {
  if (demo) fake_ms += ms ? ms : 1;
  else usleep(ms * 1000);
}
uint32_t DG_GetTicksMs(void) {
  if (demo) return fake_ms;
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint32_t)(t.tv_sec * 1000 + t.tv_nsec / 1000000);
}
/* Raw-mode keys: arrows, WASD, Ctrl/F/space to fire, E/Enter to use, Esc. Each
 * read is a press followed later by a release, since terminals report no ups. */
static unsigned char queued[64];
static int queued_len, queued_pressed[64];
static void queue(unsigned char key) {
  if (queued_len + 2 > 64) return;
  queued[queued_len] = key, queued_pressed[queued_len++] = 1;
  queued[queued_len] = key, queued_pressed[queued_len++] = 0;
}
int DG_GetKey(int* pressed, unsigned char* key) {
  if (!raw_mode) return 0;
  if (!queued_len) {
    unsigned char buf[16];
    ssize_t n = read(0, buf, sizeof buf);
    for (ssize_t i = 0; i < n; i++) {
      if (buf[i] == 3) exit(0);
      if (buf[i] == 27 && i + 2 < n && buf[i + 1] == '[') {
        unsigned char k = buf[i + 2] == 'A' ? KEY_UPARROW : buf[i + 2] == 'B' ? KEY_DOWNARROW
                        : buf[i + 2] == 'C' ? KEY_RIGHTARROW : KEY_LEFTARROW;
        queue(k);
        i += 2;
        continue;
      }
      unsigned char c = buf[i];
      queue(c == 27 ? KEY_ESCAPE : c == '\r' ? KEY_ENTER : c == 'w' ? KEY_UPARROW
            : c == 's' ? KEY_DOWNARROW : c == 'a' ? KEY_LEFTARROW : c == 'd' ? KEY_RIGHTARROW
            : c == ' ' || c == 'f' ? KEY_FIRE : c == 'e' ? KEY_USE : c);
    }
  }
  if (!queued_len) return 0;
  *key = queued[0], *pressed = queued_pressed[0];
  memmove(queued, queued + 1, --queued_len);
  memmove(queued_pressed, queued_pressed + 1, queued_len * sizeof(int));
  return 1;
}
void DG_SetWindowTitle(const char* title) { (void)title; }

int main(int argc, char** argv) {
  doomgeneric_Create(argc, argv);
  for (;;) doomgeneric_Tick();
}
