import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const output = resolve('docs/benchmarks/optimization');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const checks = [];
const cases = [
  {
    label: 'getter fallback when private attribute/content words are unavailable',
    hideWords: true,
    data: '\x1b[?25l\x1b[1;31mAAAA界é 🦀\x1b[4:3;58:2::255:0:0mBBBB\x1b[0mCCCC',
  },
  {
    label: 'attribute runs, inverse, palette, truecolor and style transitions',
    data:
      '\x1b[?25l' +
      Array.from(
        { length: 256 },
        (_, i) =>
          `\x1b[${(i % 8) + 1};${Math.floor(i / 8) * 4 + 1}H\x1b[0;${[0, 1, 2, 3, 4, 7, 8, 9, 53][i % 9]};38;5;${i};48;2;${i};${255 - i};${i % 127}mABCD`,
      ).join(''),
  },
  {
    label: 'extended attributes sharing fg/bg words',
    data: '\x1b[?25l\x1b[4:3;58:2::255:0:0mAAAA\x1b[4:4;58:2::0:255:0mBBBB\x1b[4:5;58:5:21mCCCC\x1b[0m\x1b]8;;https://example.com\x1b\\DDDD\x1b]8;;\x1b\\',
  },
  {
    label: 'spaces, erased glyphs, wide continuation, combining and emoji',
    data: '\x1b[?25lABCDEFG\x1b[H\x1b[2K界Aé 🦀\r\n\x1b[1;3;4;38;2;20;40;60m    \x1b[0mEMPTY\r\n\x1b[2K',
    partial: [1, 5],
  },
  {
    label: 'selection across attribute runs',
    data: '\x1b[?25l\x1b[1;31mAAAA\x1b[0mBBBB\x1b[7;38;5;21mCCCC\x1b[0mDDDD\r\nMMMM',
    selection: [2, 0, 20],
    options: { theme: { selectionBackground: '#335577', selectionForeground: '#ffeecc' } },
  },
  {
    label: 'bold bright colors disabled and theme mutation',
    data: '\x1b[?25l\x1b[1;31mAAAABBBB\x1b[0mCCCCDDDD\x1b[1;7;32mEEEEFFFF',
    options: {
      drawBoldTextInBrightColors: false,
      theme: { foreground: '#aabbcc', background: '#102030', red: '#123456' },
    },
  },
  {
    label: 'attribute cache rebuilt after options and theme change',
    data: '\x1b[?25l\x1b[1;31mAAAABBBB\x1b[0mCCCCDDDD\x1b[1;7;32mEEEEFFFF',
    options: {
      drawBoldTextInBrightColors: true,
      theme: { foreground: '#bbccdd', background: '#203040', red: '#345678' },
    },
  },
];
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width: 2600, height: 2100 },
      deviceScaleFactor: dpr,
    });
    const pages = [];
    for (const url of [
      process.env.WRAITH_BEFORE_URL ?? 'http://127.0.0.1:5190',
      process.env.WRAITH_URL ?? 'http://127.0.0.1:5173',
    ]) {
      const page = await context.newPage();
      pages.push(page);
      await page.goto(url + '/compare.html?type=wraith');
      await page.waitForFunction(() => window.comparison?.ready);
      await page.evaluate(() => window.comparison.ready);
      await page.evaluate(() =>
        window.comparison.setup({ type: 'wraith', workload: 'complex', cols: 128, rows: 8 }),
      );
    }
    for (const fixture of cases) {
      const old = await pages[0].evaluate((f) => window.comparison.packedFixture(f), fixture);
      const current = await pages[1].evaluate((f) => window.comparison.packedFixture(f), fixture);
      assert.deepEqual(current, old, fixture.label + ' DPR' + dpr);
      checks.push({ dpr, label: fixture.label, packedWords: current.full.length });
    }
    await context.close();
  }
} finally {
  await browser.close();
}
await writeFile(
  join(output, 'renderer-differential.json'),
  JSON.stringify({ date: new Date().toISOString(), checks }, null, 2) + '\n',
);
console.log(
  `${checks.length} differential cases passed: every packed GPU word, text and renderer state matched the unchanged build.`,
);
