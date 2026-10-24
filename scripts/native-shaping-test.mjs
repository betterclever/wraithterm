// Run shaping on WebGPU: programming ligatures (opt-in) and joined Arabic draw
// different pixels from isolated glyphs, and the cursor splits a ligature.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pixels } from './png.mjs';

const arabic = await readFile(
  new URL('../crates/wraith-engine/tests/fonts/NotoNaskhArabic.ttf', import.meta.url),
);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 900, height: 500 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/__arabic.ttf', (route) =>
    route.fulfill({ body: arabic, contentType: 'font/ttf' }),
  );
  await page.goto(process.env.WRAITH_URL ?? 'http://127.0.0.1:5173/playground.html');
  await page.waitForFunction(() => window.wraith);
  // Mount one terminal; return the PNG of cells [x0, x1) of its first row.
  const shot = async (options, text, x0, x1) => {
    const box = await page.evaluate(
      async ([options, text, x0, x1]) => {
        document.querySelector('#shape-host')?.remove();
        const host = document.createElement('div');
        host.id = 'shape-host';
        host.style.cssText =
          'position:fixed;left:0;top:0;width:600px;height:200px;z-index:10000;background:#000';
        document.body.append(host);
        if (options.fallbackFonts)
          options.fallbackFonts = [new URL('/__arabic.ttf', location.href)];
        const term = await window.wraith.constructor.mount(host, {
          cols: 30,
          rows: 4,
          fit: false,
          fontSize: 24,
          theme: { background: '#000000', foreground: '#ffffff' },
          ...options,
        });
        await term.write(text);
        await term.flush();
        window.shapeTerm = term;
        const r = term.canvas.getBoundingClientRect();
        const cw = r.width / term.cols,
          ch = r.height / term.rows;
        return { x: r.left + x0 * cw, y: r.top, width: (x1 - x0) * cw, height: ch };
      },
      [options, text, x0, x1],
    );
    const png = await page.screenshot({ clip: box });
    await page.evaluate(() => window.shapeTerm.dispose());
    return png;
  };
  const hash = (png) => createHash('sha256').update(pixels(png).data).digest('hex');
  const ink = (png) => {
    const p = pixels(png);
    let n = 0;
    for (let i = 0; i < p.data.length; i += p.bpp)
      n += p.data[i] + p.data[i + 1] + p.data[i + 2] > 200;
    return n;
  };

  // "=>" in cells 2..4, cursor parked on the next row.
  const text = 'x => y\r\n';
  const off = await shot({}, text, 2, 4);
  const on = await shot({ ligatures: true }, text, 2, 4);
  assert.notEqual(hash(on), hash(off), 'ligature pixels differ from separate glyphs');
  assert(ink(on) > 20 && ink(off) > 20);
  // The cursor inside the word restores the separate glyphs.
  const split = await shot({ ligatures: true }, 'x => y\x1b[1;4H', 2, 3);
  const offLeft = await shot({}, 'x => y\x1b[1;4H', 2, 3);
  assert.equal(hash(split), hash(offLeft), 'the word under the cursor is not ligated');
  // Plain words are unchanged by the option.
  assert.equal(
    hash(await shot({ ligatures: true }, 'hello\r\n', 0, 5)),
    hash(await shot({}, 'hello\r\n', 0, 5)),
  );

  // Arabic joins within a run: the joined word differs from spaced letters.
  const joined = await shot({ fallbackFonts: true }, 'سلام\r\n', 0, 1);
  const isolated = await shot({ fallbackFonts: true }, 'س ل ا م\r\n', 0, 1);
  assert(ink(joined) > 10 && ink(isolated) > 10, 'Arabic glyphs draw');
  assert.notEqual(hash(joined), hash(isolated), 'initial form differs from isolated form');
  assert.deepEqual(errors, []);
  console.log(
    'Shaping passed on WebGPU: opt-in ligature pixels, cursor split, unchanged plain text, joined Arabic.',
  );
} finally {
  await browser.close();
}
