// These functions are injected into the existing comparison module by the
// research runner. They reuse its real terminals, fonts, inputs and GPU fences.
export async function installPacking(a, mode, binary) {
  const { instance } = await WebAssembly.instantiate(new Uint8Array(binary));
  const e = instance.exports,
    memory = e.memory.buffer;
  const raw = new Uint32Array(memory, e.input_ptr(), 320 * 3);
  const packed = new Uint32Array(memory, e.output_ptr(), 320 * 5);
  const glyphs = new Uint32Array(memory, e.glyph_ptr(), 0x3000 * 4);
  const palette = new Uint32Array(memory, e.palette_ptr(), 256);
  const rgb = (n) => ((n & 255) << 16) | (n & 0xff00) | ((n >>> 16) & 255);
  const sync = () => {
    const c = a.renderer.core._themeService.colors;
    for (let i = 0; i < 256; i++) palette[i] = rgb(c.ansi[i].rgba >>> 8);
    glyphs.set(a.renderer.atlas.scalars);
  };
  sync();
  a.renderer.core._themeService.onChangeColors(sync);
  const stats = { attempted: 0, accepted: 0, fallback: 0 };
  a.renderer.experimentalPackRow = (words, values, offset, cols, colors, brighten) => {
    stats.attempted++;
    raw.set(words.subarray(0, cols * 3));
    const valid = e[mode === 'wasm-scalar' ? 'pack_scalar' : 'pack_simd'](
      cols,
      rgb(colors.foreground.rgba >>> 8),
      rgb(colors.background.rgba >>> 8),
      +brighten,
    );
    if (!valid) {
      stats.fallback++;
      return false;
    }
    values.set(packed.subarray(0, cols * 5), offset);
    stats.accepted++;
    return true;
  };
  return stats;
}

export async function validatePacking(a) {
  const hook = a.renderer.experimentalPackRow;
  let comparedWords = 0;
  for (const input of a.inputs) {
    a.renderer.experimentalPackRow = undefined;
    a.parse(input.bytes);
    a.renderer.full = true;
    a.draw();
    await a.finish();
    const expected = a.renderer.staging.slice();
    a.renderer.experimentalPackRow = hook;
    a.renderer.full = true;
    a.draw();
    await a.finish();
    const actual = a.renderer.staging;
    if (expected.length !== actual.length) throw new Error('Packing geometry changed');
    for (let i = 0; i < expected.length; i++)
      if (expected[i] !== actual[i])
        throw new Error(`Packing differs at word ${i}: ${expected[i]} != ${actual[i]}`);
    comparedWords += expected.length;
  }
  return { variants: a.inputs.length, comparedWords, byteIdentical: true };
}

/** Research fusion: opportunistically stage warm scalar print runs. The normal
 * row-word equality check still rejects stale data after any other mutation.
 * Dirty staged rows must upload rather than reuse their old GPU slot. */
export function installFused(a) {
  const r = a.renderer,
    input = a.terminal._core._inputHandler,
    original = input.print;
  r.experimentalDirty = new Uint8Array(a.terminal.rows);
  const rgb = (n) => ((n & 255) << 16) | (n & 0xff00) | ((n >>> 16) & 255);
  const color = (word, front, c, bright) => {
    const mode = word & 0x3000000;
    if (mode === 0x3000000) return rgb(word);
    if (mode) {
      const at = word & 255;
      return rgb(c.ansi[at + (bright && at < 8 ? 8 : 0)].rgba >>> 8);
    }
    return rgb((front ? c.foreground : c.background).rgba >>> 8);
  };
  const fused = function (data, start, end) {
    const b = this._activeBuffer,
      x = b.x,
      base = b.ybase,
      cursorY = b.y,
      viewport = b.ydisp;
    const y = base + cursorY - viewport,
      cols = a.terminal.cols;
    const eligible =
      !r.full &&
      !r.selectedStart &&
      y >= 0 &&
      y < a.terminal.rows &&
      r.rowCached[y] === 1 &&
      viewport === r.lastViewportY &&
      r.staging.buffer === r.memory.buffer;
    original.call(this, data, start, end);
    if (
      !eligible ||
      this._activeBuffer !== b ||
      b.ybase !== base ||
      b.y !== cursorY ||
      b.ydisp !== viewport ||
      b.x !== x + end - start ||
      b.x > cols
    )
      return;
    const words = b.lines.get(base + cursorY)._data,
      scalars = r.atlas.scalars;
    for (let j = x; j < b.x; j++) {
      const content = words[j * 3],
        fg = words[j * 3 + 1],
        bg = words[j * 3 + 2],
        cp = content & 0x1fffff;
      const style = ((fg >>> 27) & 1) | (((bg >>> 26) & 1) << 1);
      if (
        bg & 0x10000000 ||
        content & 0x200000 ||
        content >>> 22 > 2 ||
        cp >= 0x3000 ||
        (content >>> 22 && cp !== 0 && cp !== 32 && !scalars[cp * 4 + style])
      )
        return;
    }
    const c = r.core._themeService.colors,
      brighten = !!a.terminal.options.drawBoldTextInBrightColors;
    for (let j = x; j < b.x; j++) {
      const content = words[j * 3],
        f = words[j * 3 + 1],
        b = words[j * 3 + 2],
        cp = content & 0x1fffff,
        inverse = !!(f & 0x4000000);
      const fg = color(inverse ? b : f, !inverse, c, !!(f & 0x8000000) && brighten),
        bg = color(inverse ? f : b, inverse, c, false);
      const flags =
        ((f >>> 27) & 1) |
        (((b >>> 26) & 1) << 1) |
        (((b >>> 27) & 1) << 2) |
        (((f >>> 30) & 1) << 4) |
        ((f >>> 31) << 5) |
        (((b >>> 30) & 1) << 6) |
        (((f >>> 28) & 1) << 8);
      const at = (y * cols + j) * 5;
      r.staging[at] = fg;
      r.staging[at + 1] = bg;
      r.staging[at + 2] = f & 0x3000000 ? color(f, true, c, false) : fg;
      r.staging[at + 3] = content >>> 22 === 2 ? flags | 65536 : flags;
      r.staging[at + 4] =
        content >>> 22 && cp !== 0 && cp !== 32 ? scalars[cp * 4 + (flags & 3)] : 0;
      const raw = (y * cols + j) * 3;
      r.rowWords[raw] = content;
      r.rowWords[raw + 1] = f;
      r.rowWords[raw + 2] = b;
    }
    r.experimentalDirty[y] = 1;
  };
  input.print = fused;
  return { original, fused };
}

export async function validateFused(a, hook) {
  const input = a.terminal._core._inputHandler,
    r = a.renderer;
  let comparedWords = 0;
  for (const sample of a.inputs) {
    a.parse(sample.bytes);
    a.draw();
    await a.finish();
    const actual = r.staging.slice();
    input.print = hook.original;
    r.full = true;
    a.draw();
    await a.finish();
    const expected = r.staging;
    for (let i = 0; i < actual.length; i++)
      if (actual[i] !== expected[i]) throw new Error(`Fused staging differs at word ${i}`);
    comparedWords += actual.length;
    input.print = hook.fused;
  }
  return { variants: a.inputs.length, comparedWords, byteIdentical: true };
}

export async function stageCeiling(a, frames = 2048) {
  if (a.type !== 'wraith') throw new Error('Stage ceiling requires the Wraith compositor');
  const r = a.renderer,
    rows = a.terminal.rows;
  const banks = [];
  for (const input of a.inputs) {
    a.parse(input.bytes);
    a.draw();
    await a.finish();
    banks.push({ cells: r.staging.slice(), view: r.view.slice(), frame: r.frame.slice() });
  }
  const results = [];
  for (const mode of ['parse-only', 'pack-only', 'prepacked-full-upload', 'retained-redraw']) {
    const before = a.submitted(),
      uploads = a.uploads();
    const started = performance.now();
    for (let i = 0; i < frames; i++) {
      if (mode === 'parse-only') a.parse(a.inputs[i % 8].bytes);
      else if (mode === 'pack-only') {
        r.rowCached.fill(0);
        r.pack(0, rows - 1);
      } else {
        if (mode === 'prepacked-full-upload') {
          const bank = banks[i % 8];
          r.staging.set(bank.cells);
          r.view.set(bank.view);
          r.frame.set(bank.frame);
          r.rowSources.fill(0xffffffff);
        } else {
          for (let y = 0; y < rows; y++) r.rowSources[y] = y;
        }
        if (!r.gpu.render_retained()) throw new Error('GPU stage did not submit');
        if ((i + 1) % 32 === 0) await a.finish();
      }
    }
    if (mode.includes('upload') || mode.includes('redraw')) await a.finish();
    const elapsedMs = performance.now() - started;
    const submissions = a.submitted() - before,
      after = a.uploads();
    if (submissions !== (mode === 'parse-only' || mode === 'pack-only' ? 0 : frames))
      throw new Error('Stage submission count mismatch');
    results.push({
      mode,
      frames,
      elapsedMs,
      updatesPerSecond: (frames * 1000) / elapsedMs,
      submittedFrames: submissions,
      gpuFenced: submissions > 0,
      uploads: { cells: after.cells - uploads.cells, rowMap: after.rowMap - uploads.rowMap },
      measured:
        mode === 'parse-only'
          ? 'CPU input only, no drawing'
          : mode === 'pack-only'
            ? 'CPU full packing of a warm fixed viewport, no drawing'
            : mode === 'prepacked-full-upload'
              ? 'Eight prepacked snapshots, full cell upload and GPU draw; parsing/packing excluded'
              : 'Fixed retained GPU image; no new input or cell uploads',
    });
  }
  // Restore CPU staging/cache ownership after the intentionally artificial GPU loop.
  r.rowCached.fill(0);
  r.full = true;
  a.draw();
  await a.finish();
  return results;
}
