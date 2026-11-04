// Kitty graphics PNGs on WebGPU, past the basics native-kitty-test covers:
// alpha blending over text, a large gradient sent in many chunks and scaled
// to cells, one image placed several times, deleting a single placement,
// placements that scroll with their text, and the query reply.
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
/** An 8-bit RGBA PNG whose pixel (x, y) is `color(x, y)`. */
function png(width, height, color) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(color(x, y), y * (1 + width * 4) + 1 + x * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const apc = (control, payload) =>
  `\x1b_G${control};${Buffer.from(payload).toString('base64')}\x1b\\`;
/** A transmission split into kitty's 4096-byte chunks. */
function chunked(control, payload) {
  const data = Buffer.from(payload).toString('base64');
  const parts = data.match(/.{1,4096}/g);
  return parts
    .map((part, i) => {
      const more = i + 1 < parts.length ? 1 : 0;
      return `\x1b_G${i ? '' : `${control},`}m=${more};${part}\x1b\\`;
    })
    .join('');
}

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
    host.id = 'png-terminal';
    host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:600px;z-index:10000';
    document.body.append(host);
    const term = (window.pngTerm = await window.wraith.constructor.mount(host, {
      cols: 40,
      rows: 12,
      fit: false,
      theme: { background: '#000000', foreground: '#ffffff' },
    }));
    window.pngReplies = '';
    term.onBytes((bytes) => (window.pngReplies += String.fromCharCode(...bytes)));
    return { width: term.cellWidth, height: term.cellHeight };
  });
  const write = (data) =>
    page.evaluate(async (data) => {
      await window.pngTerm.write(data);
      await window.pngTerm.flush();
    }, data);
  const shot = async () => pixels(await page.locator('#png-terminal canvas').screenshot());
  const at = (image, x, y) => {
    const i = (Math.floor(y) * image.width + Math.floor(x)) * image.bpp;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  const near = (actual, expected, label, tolerance = 3) =>
    assert(
      actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
      `${label}: ${actual} != ${expected}`,
    );

  // 1. The query: supported, nothing stored.
  await write(apc('a=q,i=31,f=24,s=1,v=1', [255, 0, 0]));
  // 2. Half-transparent red over a row of white blocks (z=1, above text):
  // where the blocks are, red over white; elsewhere, red over black.
  await write('\x1b[1;1H████');
  await write(
    `\x1b[1;1H${apc(
      'a=T,f=100,i=1,c=8,r=1,z=1,C=1',
      png(8, 1, () => [255, 0, 0, 128]),
    )}`,
  );
  // 3. A 256×64 gradient, red rising left to right and blue top to bottom,
  // in many chunks, scaled to 16×4 cells at row 3.
  const gradient = png(256, 64, (x, y) => [x, 0, y * 4, 255]);
  const transfer = chunked('a=T,f=100,i=2,c=16,r=4,C=1', gradient);
  assert(transfer.split('\x1b_G').length > 3, 'several chunks');
  await write(`\x1b[3;1H${transfer}`);
  // 4. One green image placed twice (p=1, p=2) on row 9.
  await write(
    apc(
      'a=t,f=100,i=3',
      png(4, 4, () => [0, 255, 0, 255]),
    ),
  );
  await write('\x1b[9;21H\x1b_Ga=p,i=3,p=1,c=2,r=1,C=1\x1b\\');
  await write('\x1b[9;31H\x1b_Ga=p,i=3,p=2,c=2,r=1,C=1\x1b\\');

  let image = await shot();
  if (process.env.DEBUG)
    await page.locator('#png-terminal canvas').screenshot({ path: process.env.DEBUG });
  // Alpha 128: red over white keeps red full and halves the rest; over black
  // it halves red.
  near(at(image, cw / 2, ch / 2), [255, 127, 127], 'alpha over a white block', 6);
  near(at(image, 6 * cw + cw / 2, ch / 2), [128, 0, 0], 'alpha over the background', 6);
  // Gradient corners and middle, sampled inside the scaled 16×4 cells.
  const gx = (f) => 16 * cw * f,
    gy = (f) => 2 * ch + 4 * ch * f;
  const left = at(image, gx(0.02), gy(0.5)),
    right = at(image, gx(0.98), gy(0.5)),
    top = at(image, gx(0.5), gy(0.03)),
    bottom = at(image, gx(0.5), gy(0.97));
  assert(right[0] - left[0] > 200, `red rises left to right: ${left} → ${right}`);
  assert(bottom[2] - top[2] > 180, `blue rises top to bottom: ${top} → ${bottom}`);
  near(at(image, 16 * cw + 3, gy(0.5)), [0, 0, 0], 'the gradient ends at 16 cells');
  near(at(image, 20 * cw + cw, 8 * ch + ch / 2), [0, 255, 0], 'first placement');
  near(at(image, 30 * cw + cw, 8 * ch + ch / 2), [0, 255, 0], 'second placement');

  // 5. Deleting placement 2 keeps placement 1 and the image.
  await write('\x1b_Ga=d,d=i,i=3,p=2\x1b\\');
  image = await shot();
  near(at(image, 20 * cw + cw, 8 * ch + ch / 2), [0, 255, 0], 'placement 1 stays');
  near(at(image, 30 * cw + cw, 8 * ch + ch / 2), [0, 0, 0], 'placement 2 is gone');

  // 6. Scrolling: two new lines at the bottom move every placement up two rows.
  await write('\x1b[12;1H\r\n\r\n');
  image = await shot();
  near(at(image, 20 * cw + cw, 6 * ch + ch / 2), [0, 255, 0], 'placement scrolled up');
  near(at(image, 20 * cw + cw, 8 * ch + ch / 2), [0, 0, 0], 'its old row is clear');

  const replies = await page.evaluate(() => window.pngReplies);
  assert.match(replies, /\x1b_Gi=31;OK\x1b\\/, 'query reply');
  for (const id of [1, 2, 3]) assert.match(replies, new RegExp(`\\x1b_Gi=${id}[,;][^\\x1b]*OK`));
  await page.evaluate(() => window.pngTerm.dispose());
  assert.deepEqual(errors, []);
  console.log(
    `Kitty PNGs passed on WebGPU (${cw}×${ch} px cells): query, alpha over text, chunked scaled gradient, repeated placements, single deletion, scrolling.`,
  );
} finally {
  await browser.close();
}
