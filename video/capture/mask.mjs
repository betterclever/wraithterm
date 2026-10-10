// Rasterizes the WRAITH wordmark (and the stat glyph sizes) into a coarse alpha grid that
// the video draws as glowing terminal half-block pixels.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage();
await page.setContent('<canvas></canvas>');
const mask = await page.evaluate(() => {
  const w = 104, h = 26;
  const c = document.querySelector('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 40;
  g.font = `900 ${size}px Helvetica, Arial, sans-serif`;
  size = (size * w * 0.97) / g.measureText('WRAITH').width;
  g.font = `900 ${size}px Helvetica, Arial, sans-serif`;
  g.fillText('WRAITH', w / 2, h / 2 + 1);
  const a = g.getImageData(0, 0, w, h).data;
  const rows = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) r += '_.:-=+*#%@'[Math.min(9, Math.floor((a[(y * w + x) * 4 + 3] / 256) * 10))];
    rows.push(r);
  }
  return rows.join('\n');
});
await writeFile(resolve(import.meta.dirname, '../src/wordmark.txt'), mask + '\n');
console.log(mask);
await browser.close();
