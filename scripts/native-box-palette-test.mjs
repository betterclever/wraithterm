// Box drawing and theme palettes on WebGPU: a border drawn at a line height
// where a font's box glyphs stop short of the cell joins with no gap between
// rows or cells, and a theme's palette colors ANSI text, live.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { pixels } from './png.mjs';

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
  const { width: cw, height: ch } = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'box-terminal';
    host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:400px;z-index:10000';
    document.body.append(host);
    const term = (window.boxTerm = await window.wraith.constructor.mount(host, {
      cols: 30,
      rows: 8,
      fit: false,
      fontSize: 15,
      lineHeight: 1.6,
      theme: {
        background: '#000000',
        foreground: '#ffffff',
        palette: ['#000000', '#0000ff', '#00ff00'],
      },
    }));
    await term.write(
      '┌────────┐ ╭──╮\r\n│ border │ ╰──╯\r\n├────────┤\r\n│        │\r\n└────────┘\r\n' +
        '\x1b[31m██\x1b[32m██\x1b[0m',
    );
    await term.flush();
    return { width: term.cellWidth, height: term.cellHeight };
  });
  const shot = async () => pixels(await page.locator('#box-terminal canvas').screenshot());
  const alpha = (image, x, y) => {
    const i = (y * image.width + x) * image.bpp;
    return Math.max(image.data[i], image.data[i + 1], image.data[i + 2]);
  };
  const at = (image, x, y) => {
    const i = (Math.floor(y) * image.width + Math.floor(x)) * image.bpp;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  let image = await shot();
  if (process.env.DEBUG)
    await page.locator('#box-terminal canvas').screenshot({ path: process.env.DEBUG });

  // The left border: one pixel column lit from the top row's centre to the
  // bottom row's centre, through four row boundaries.
  const column = [...Array(cw).keys()].find((x) => alpha(image, x, 2 * ch) > 200);
  assert(column !== undefined, 'a lit column in the left border');
  for (let y = Math.floor(ch / 2) + 1; y < 4 * ch + ch / 2; y++)
    assert(alpha(image, column, y) > 200, `the border has no gap at y=${y}`);
  // The top border: one pixel row lit across ten cells.
  const row = [...Array(ch).keys()].find((y) => alpha(image, 3 * cw, y) > 200);
  assert(row !== undefined, 'a lit row in the top border');
  for (let x = Math.floor(cw / 2) + 1; x < 9 * cw + cw / 2; x++)
    assert(alpha(image, x, row) > 200, `the top border has no gap at x=${x}`);
  // ╭ meets ─ in the next cell.
  assert(alpha(image, 12 * cw - 1, row) > 150 && alpha(image, 12 * cw + 1, row) > 150);

  // Palette: red is the theme's blue, green its green.
  const swatch = (col) => at(image, col * cw + cw / 2, 5 * ch + ch / 2);
  assert.deepEqual(swatch(0), [0, 0, 255], 'ANSI red from the palette');
  assert.deepEqual(swatch(2), [0, 255, 0], 'ANSI green from the palette');
  // Live: a new palette recolors what is on screen.
  await page.evaluate(async () => {
    window.boxTerm.setTheme({ palette: ['#000000', '#ff8800'] });
    await window.boxTerm.flush();
  });
  image = await shot();
  assert.deepEqual(swatch(0), [255, 136, 0], 'the new palette applies to existing text');
  const green = swatch(2);
  assert(green[1] > 100 && green[1] < 255, `green back to the built-in: ${green}`);

  await page.evaluate(() => window.boxTerm.dispose());
  assert.deepEqual(errors, []);
  console.log(
    `Box drawing and palettes passed on WebGPU (${cw}×${ch} px cells): seamless borders across rows and cells, rounded joins, ANSI palette, live palette change.`,
  );
} finally {
  await browser.close();
}
