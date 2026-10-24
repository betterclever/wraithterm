import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { pixels } from '../png.mjs';
import './prepare.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, process.env.WRAITH_REPORT_DIR ?? '.cache/competitor-validation');
await mkdir(output, { recursive: true });
const targets = ['wraith', 'ghostty', 'restty', 'ghostty-web', 'webgl'];
const fixtures = [
  { name: 'combining', data: 'e\u0301 a\u0308 o\u0302' },
  { name: 'right-margin-combining', data: '\x1b[1;239He\u0301a\u0308' },
  { name: 'wide-overwrite', data: '你a\rZ' },
  { name: 'zwj-emoji-width', data: 'A👩‍💻B\r\nnext' },
  { name: 'sgr-between-combining', data: 'e\x1b[31m\u0301' },
  { name: 'alternate-buffer', data: 'normal\x1b[?1049halternate\x1b[?1049l' },
  { name: 'saved-cursor', data: 'AB\x1b7\x1b[3;10Htemp\x1b8C' },
  { name: 'scroll-region', data: 'one\r\ntwo\r\nthree\r\nfour\x1b[2;4r\x1b[4;1H\r\nnew' },
  { name: 'hyperlink', data: '\x1b]8;;https://example.com\x1b\\example\x1b]8;;\x1b\\' },
];
const colors = [
  0x000000, 0x102030, 0xff0000, 0x00ff00, 0x0000ff, 0xff00ff, 0xffff00, 0x00ffff, 0xffffff,
];
fixtures.push({
  name: 'truecolor-backgrounds',
  data:
    colors.map((c) => `\x1b[48;2;${c >>> 16};${(c >>> 8) & 255};${c & 255}m    `).join('') +
    '\x1b[0m',
});
fixtures.push({
  name: 'underline-styles',
  data:
    [1, 2, 3, 4, 5]
      .map((s, y) => `\x1b[${y + 1};1H\x1b[0;4:${s};38;2;255;255;255;48;2;0;0;0m${' '.repeat(40)}`)
      .join('') + '\x1b[0m',
});
const results = [],
  errors = [];
const server = await createServer({
  configFile: false,
  root,
  cacheDir: join(root, '.cache/competitor-vite'),
  server: { host: '127.0.0.1', port: 5196, strictPort: true },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width: 2600, height: 2100 },
      deviceScaleFactor: dpr,
    });
    for (const target of targets) {
      const page = await context.newPage();
      await page.addInitScript(() => {
        window.__wraithValidationCapture = true;
      });
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(m.text());
      });
      try {
        await page.goto('http://127.0.0.1:5196/scripts/competitors/browser.html');
        await page.waitForFunction(() => window.competitor?.ready);
        const scene = await page.evaluate((target) => window.competitor.setup(target), target);
        for (const fixture of fixtures) {
          const result = await page.evaluate(
            (data) => window.competitor.fixture(data),
            fixture.data,
          );
          const record = {
            target,
            dpr,
            fixture: fixture.name,
            text: result.text,
            publicText: result.publicText,
            geometry: result.geometry,
          };
          if (fixture.name === 'truecolor-backgrounds' || fixture.name === 'underline-styles') {
            const path = join(output, `${target}-${fixture.name}-dpr${dpr}.png`);
            const image = await page.screenshot({
              path,
              clip: { x: 0, y: 0, width: 360, height: 120 },
            });
            const decoded = pixels(image);
            record.screenshotSha256 = createHash('sha256').update(image).digest('hex');
            if (fixture.name === 'truecolor-backgrounds') {
              record.colors = colors.map((_, i) => {
                const x = (i * 36 + 18) * dpr,
                  y = 10 * dpr,
                  offset = (y * decoded.width + x) * decoded.bpp;
                return [...decoded.data.subarray(offset, offset + 3)];
              });
              record.expectedColors = colors.map((c) => [c >>> 16, (c >>> 8) & 255, c & 255]);
              record.colorsMatch =
                JSON.stringify(record.colors) === JSON.stringify(record.expectedColors);
            } else {
              // Row fingerprints describe distinct underline styles without
              // assuming identical antialiasing or underline placement.
              record.underlineRows = Array.from({ length: 5 }, (_, y) =>
                createHash('sha256')
                  .update(
                    decoded.data.subarray(
                      y * 20 * dpr * decoded.width * decoded.bpp,
                      (y + 1) * 20 * dpr * decoded.width * decoded.bpp,
                    ),
                  )
                  .digest('hex'),
              );
              record.distinctUnderlineRows = new Set(record.underlineRows).size;
            }
          }
          results.push(record);
        }
        results.push({
          target,
          dpr,
          fixture: 'dense-core-versus-public-buffer',
          text: scene.text,
          publicText: scene.publicText,
          publicMatches:
            scene.publicText === undefined ? undefined : scene.publicText === scene.text,
        });
        if (pageErrors.length) errors.push({ target, dpr, pageErrors });
        console.log(
          `Validated ${target} DPR${dpr}: ${fixtures.length} fixtures, errors=${pageErrors.length}`,
        );
      } catch (error) {
        errors.push({ target, dpr, error: String(error), pageErrors });
        console.log(`Failed ${target} DPR${dpr}: ${error}`);
      } finally {
        await page.evaluate(() => window.competitor?.dispose()).catch(() => {});
        await page.close();
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
const comparisons = [];
for (const dpr of [1, 2])
  for (const fixture of fixtures) {
    const reference = results.find(
      (r) => r.target === 'webgl' && r.dpr === dpr && r.fixture === fixture.name,
    );
    for (const target of targets) {
      const result = results.find(
        (r) => r.target === target && r.dpr === dpr && r.fixture === fixture.name,
      );
      if (result && reference)
        comparisons.push({
          target,
          dpr,
          fixture: fixture.name,
          textMatchesXterm: result.text === reference.text,
          colorsMatch: result.colorsMatch,
          distinctUnderlineRows: result.distinctUnderlineRows,
        });
    }
  }
await writeFile(
  join(output, 'validation.json'),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      packages: JSON.parse(await readFile(join(import.meta.dirname, 'package-lock.json'))),
      fixtures,
      results,
      comparisons,
      errors,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify(
    {
      errors,
      mismatches: comparisons.filter((c) => !c.textMatchesXterm || c.colorsMatch === false),
    },
    null,
    2,
  ),
);
assert.deepEqual(errors, [], 'Competitor validation failed to run completely');
