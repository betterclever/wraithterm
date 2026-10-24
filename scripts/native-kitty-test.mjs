// Kitty graphics on WebGPU: placements draw at their cell and pixel positions,
// honour scaling, z-layers and deletion, and replies reach the application.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import { pixels } from './png.mjs';

const chunk = (kind, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(kind, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind), data])), 8 + data.length);
  return out;
};
// A filter-0 RGB PNG of one solid color.
function png(width, height, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 3).fill(Buffer.from([r, g, b])),
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const apc = (control, payload) =>
  `\x1b_G${control};${Buffer.from(payload).toString('base64')}\x1b\\`;

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
  const cell = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'kitty-terminal';
    host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:600px;z-index:10000';
    document.body.append(host);
    const term = (window.kittyTerm = await window.wraith.constructor.mount(host, {
      cols: 40,
      rows: 10,
      fit: false,
      theme: { background: '#000000', foreground: '#ffffff' },
    }));
    window.kittyReplies = '';
    term.onBytes((bytes) => (window.kittyReplies += String.fromCharCode(...bytes)));
    return { width: term.cellWidth, height: term.cellHeight };
  });
  const { width: cw, height: ch } = cell;
  const write = (data) =>
    page.evaluate(async (data) => {
      await window.kittyTerm.write(data);
      await window.kittyTerm.flush();
    }, data);
  const shot = async () => pixels(await page.locator('#kitty-terminal canvas').screenshot());
  const at = (image, x, y) => {
    const i = (Math.floor(y) * image.width + Math.floor(x)) * image.bpp;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  const near = (actual, expected, label) =>
    assert(
      actual.every((v, i) => Math.abs(v - expected[i]) <= 2),
      `${label}: ${actual} != ${expected}`,
    );

  // 1. Raw RGBA, exactly two cells by one, at the origin (C=1 keeps the cursor).
  const rgba = Buffer.alloc(2 * cw * ch * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([255, 0, 0, 255], i);
  await write(apc(`a=T,f=32,s=${2 * cw},v=${ch},i=1,C=1`, rgba));
  // 2. PNG, 3×3 pixels scaled to 2×2 cells at row 2, column 10.
  await write(`\x1b[3;11H${apc('a=T,f=100,i=2,c=2,r=2,C=1', png(3, 3, [0, 255, 0]))}`);
  // 3. Zlib-compressed RGB in two chunks at row 6, column 20.
  const blue = Buffer.alloc(cw * ch * 3);
  for (let i = 0; i < blue.length; i += 3) blue.set([0, 0, 255], i);
  const z = deflateSync(blue).toString('base64'),
    half = Math.floor(z.length / 8) * 4;
  await write(
    `\x1b[7;21H\x1b_Ga=T,f=24,o=z,s=${cw},v=${ch},i=3,C=1,m=1;${z.slice(0, half)}\x1b\\` +
      `\x1b_Gm=0;${z.slice(half)}\x1b\\`,
  );
  // 4. Below backgrounds: shows through default cells, hidden by colored ones.
  const white = Buffer.alloc(4 * cw * ch * 4, 255);
  await write(
    `\x1b[9;31H${apc(`a=T,f=32,s=${4 * cw},v=${ch},i=4,z=-1073741825,C=1`, white)}` +
      `\x1b[9;33H\x1b[44m  \x1b[0m`,
  );
  let image = await shot();
  if (process.env.DEBUG)
    await page.locator('#kitty-terminal canvas').screenshot({ path: process.env.DEBUG });
  near(at(image, 1, 1), [255, 0, 0], 'RGBA origin');
  near(at(image, 2 * cw - 2, ch - 2), [255, 0, 0], 'RGBA far corner');
  near(at(image, 2 * cw + 2, ch / 2), [0, 0, 0], 'RGBA ends at two cells');
  near(at(image, 10 * cw + 2, 2 * ch + 2), [0, 255, 0], 'scaled PNG start');
  near(at(image, 12 * cw - 2, 4 * ch - 2), [0, 255, 0], 'scaled PNG end');
  near(at(image, 12 * cw + 2, 4 * ch - 2), [0, 0, 0], 'scaled PNG width');
  near(at(image, 20 * cw + cw / 2, 6 * ch + ch / 2), [0, 0, 255], 'zlib RGB');
  near(at(image, 30 * cw + 2, 8 * ch + 2), [255, 255, 255], 'below-background image');
  const covered = at(image, 32 * cw + cw / 2, 8 * ch + ch / 2);
  assert(covered[2] > covered[0] + 40, `colored cell covers image: ${covered}`);

  // 5. Deletion clears every placement on the next frame.
  await write('\x1b_Ga=d,d=A\x1b\\');
  image = await shot();
  near(at(image, 1, 1), [0, 0, 0], 'deleted RGBA');
  near(at(image, 10 * cw + 2, 2 * ch + 2), [0, 0, 0], 'deleted PNG');

  const replies = await page.evaluate(() => window.kittyReplies);
  for (const id of [1, 2, 3, 4]) assert.match(replies, new RegExp(`\\x1b_Gi=${id};OK\\x1b\\\\`));
  const stats = await page.evaluate(async () => {
    const term = window.kittyTerm;
    await term.dispose();
    return true;
  });
  assert(stats);
  assert.deepEqual(errors, []);
  console.log(
    `Kitty graphics passed on WebGPU (${cw}×${ch} px cells): RGBA, scaled PNG, chunked zlib RGB, below-background layering, deletion and replies.`,
  );
} finally {
  await browser.close();
}
