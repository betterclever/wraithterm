const textEncoder = new TextEncoder();
const numbers = Array.from({ length: 256 }, (_, i) => textEncoder.encode(String(i)));
const glyphs = new Map([['▀', Uint8Array.of(0xe2, 0x96, 0x80)]]);
const channel = (v) => Math.min(255, Math.max(0, Math.round(v)));
const color = (pixels, offset) =>
  (channel(pixels[offset]) << 16) |
  (channel(pixels[offset + 1]) << 8) |
  channel(pixels[offset + 2]);

/** Lossless truecolor ANSI output. Reuse scratch memory and emit UTF-8 directly;
 * return an owned buffer so transferring one frame cannot detach the next. */
export class AnsiFrameEncoder {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.scratch = new Uint8Array(cols * rows * 48 + rows * 16 + 64);
  }
  encode(pixels, chars, ink) {
    const { cols, rows, scratch: out } = this;
    let at = 0,
      foreground = -1,
      background = -1,
      sgrChanges = 0;
    const bytes = (data) => {
      out.set(data, at);
      at += data.length;
    };
    const number = (value) => {
      // Row coordinates can exceed 255 on other callers; this demo has <=100.
      bytes(numbers[value]);
    };
    const rgb = (value) => {
      number(value >>> 16);
      out[at++] = 59;
      number((value >>> 8) & 255);
      out[at++] = 59;
      number(value & 255);
    };
    // Hide cursor and disable wrapping, as in the reference full-frame encoder.
    bytes(Uint8Array.of(27, 91, 63, 50, 53, 108, 27, 91, 63, 55, 108));
    for (let y = 0; y < rows; y++) {
      out[at++] = 27;
      out[at++] = 91;
      number(y + 1);
      out[at++] = 59;
      out[at++] = 49;
      out[at++] = 72;
      for (let x = 0; x < cols; x++) {
        const cell = y * cols + x,
          offset = (y * 2 * cols + x) * 3;
        const char = chars[cell] || '▀';
        const fg = chars[cell] ? ink[cell] : color(pixels, offset);
        const bg = color(pixels, offset + cols * 3);
        if (fg !== foreground || bg !== background) {
          out[at++] = 27;
          out[at++] = 91;
          if (fg !== foreground) {
            out[at++] = 51;
            out[at++] = 56;
            out[at++] = 59;
            out[at++] = 50;
            out[at++] = 59;
            rgb(fg);
            if (bg !== background) out[at++] = 59;
          }
          if (bg !== background) {
            out[at++] = 52;
            out[at++] = 56;
            out[at++] = 59;
            out[at++] = 50;
            out[at++] = 59;
            rgb(bg);
          }
          out[at++] = 109;
          foreground = fg;
          background = bg;
          sgrChanges++;
        }
        let encoded = glyphs.get(char);
        if (!encoded) {
          encoded = textEncoder.encode(char);
          glyphs.set(char, encoded);
        }
        bytes(encoded);
      }
    }
    out[at++] = 27;
    out[at++] = 91;
    out[at++] = 48;
    out[at++] = 109;
    return { bytes: out.slice(0, at), sgrChanges };
  }
}
