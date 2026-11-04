// Style faces on WebGPU: bold, italic and bold italic draw from faces of
// their own, regular cells and the cell geometry do not change, faces swap
// live through setFont, and a character a face lacks falls back to the
// regular fonts, synthesized.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pixels } from './png.mjs';

const root = new URL('..', import.meta.url);
const font = async (path) => (await readFile(new URL(path, root))).toString('base64');
const fonts = {
  regular: await font('demo/fonts/JetBrainsMono-Regular.ttf'),
  italic: await font('crates/wraith-engine/tests/fonts/Lilex-MediumItalic.otf'),
  boldItalic: await font('crates/wraith-engine/tests/fonts/Lilex-BoldItalic.otf'),
  devanagari: await font('crates/wraith-engine/tests/fonts/NotoSansDevanagari.ttf'),
};

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
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.WRAITH_URL ?? 'http://127.0.0.1:5173/playground.html');
  await page.waitForFunction(() => window.wraith);
  // Two terminals, one with faces, one without, showing the same text:
  // regular, italic, bold italic and bold runs, then Devanagari in italic.
  const TEXT = 'aaaa \x1b[3maaaa\x1b[0m \x1b[1;3maaaa\x1b[0m \x1b[1maaaa\x1b[0m \x1b[3mकख\x1b[0m';
  const cells = await page.evaluate(
    async ({ fonts, text }) => {
      const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const mount = async (id, top, faces) => {
        const host = document.createElement('div');
        host.id = id;
        host.style.cssText = `position:fixed;left:0;top:${top}px;width:900px;height:120px;z-index:10000`;
        document.body.append(host);
        const term = await window.wraith.constructor.mount(host, {
          cols: 40,
          rows: 3,
          fit: false,
          fontSize: 16,
          font: bytes(fonts.regular),
          fallbackFonts: [bytes(fonts.devanagari)],
          fontFaces: faces,
          theme: { background: '#000000', foreground: '#ffffff' },
        });
        await term.write(text);
        await term.flush();
        return term;
      };
      window.plain = await mount('plain', 0, undefined);
      window.faced = await mount('faced', 200, {
        italic: bytes(fonts.italic),
        boldItalic: bytes(fonts.boldItalic),
      });
      window.fontBytes = fonts;
      return [
        [window.plain.cellWidth, window.plain.cellHeight],
        [window.faced.cellWidth, window.faced.cellHeight],
      ];
    },
    { fonts, text: TEXT },
  );
  assert.deepEqual(cells[0], cells[1], 'faces never change the cell geometry');
  const [cw, ch] = cells[0];
  const shot = async (id) => pixels(await page.locator(`#${id} canvas`).screenshot());
  // Summed absolute difference, and the ink, over a run of cells on row 0.
  const region = (image, col, count) => {
    const values = [];
    for (let y = 0; y < ch; y++)
      for (let x = col * cw; x < (col + count) * cw; x++) {
        const i = (y * image.width + x) * image.bpp;
        values.push(image.data[i] + image.data[i + 1] + image.data[i + 2]);
      }
    return values;
  };
  const diff = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0);
  const ink = (values) => values.reduce((sum, v) => sum + v, 0);
  const runs = {
    regular: [0, 4],
    italic: [5, 4],
    boldItalic: [10, 4],
    bold: [15, 4],
    deva: [20, 2],
  };
  const compare = (a, b) =>
    Object.fromEntries(
      Object.entries(runs).map(([name, [col, n]]) => [
        name,
        diff(region(a, col, n), region(b, col, n)),
      ]),
    );

  let plain = await shot('plain'),
    faced = await shot('faced');
  if (process.env.DEBUG) {
    await page.locator('#plain canvas').screenshot({ path: `${process.env.DEBUG}-plain.png` });
    await page.locator('#faced canvas').screenshot({ path: `${process.env.DEBUG}-faced.png` });
  }
  let d = compare(plain, faced);
  assert.equal(d.regular, 0, 'regular cells are untouched by faces');
  assert.equal(d.bold, 0, 'bold without a face is synthesized as before');
  assert(d.italic > 1000, `italic draws the italic face (${d.italic})`);
  assert(d.boldItalic > 1000, `bold italic draws its own face (${d.boldItalic})`);
  assert.equal(d.deva, 0, 'a character the face lacks falls back, synthesized');
  assert(ink(region(faced, ...runs.deva)) > 0, 'the fallback draws the Devanagari');

  // Removing the faces live returns to the synthesized styles…
  await page.evaluate(async () => {
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await window.faced.setFont(bytes(window.fontBytes.regular), {
      fallbackFonts: [bytes(window.fontBytes.devanagari)],
      fontFaces: {},
    });
    await window.faced.flush();
  });
  faced = await shot('faced');
  d = compare(plain, faced);
  assert.deepEqual(Object.values(d), [0, 0, 0, 0, 0], 'no faces: identical to plain');

  // …and giving one back (italic only) applies it to both italic styles.
  await page.evaluate(async () => {
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await window.faced.setFont(bytes(window.fontBytes.regular), {
      fontFaces: { italic: bytes(window.fontBytes.italic) },
    });
    await window.faced.flush();
  });
  faced = await shot('faced');
  d = compare(plain, faced);
  assert(d.italic > 1000 && d.boldItalic > 1000, 'the italic face, emboldened for bold italic');
  assert.equal(d.regular + d.bold, 0);

  await page.evaluate(async () => {
    await window.plain.dispose();
    await window.faced.dispose();
  });
  assert.deepEqual(errors, []);
  console.log(
    `Style faces passed on WebGPU (${cw}×${ch} px cells): italic and bold italic faces, synthesized bold, fallback coverage, live swaps.`,
  );
} finally {
  await browser.close();
}
