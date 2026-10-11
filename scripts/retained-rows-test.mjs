// Compare incremental retained frames to an immutable pre-change renderer.
// Screenshots validate actual GPU row bindings, not just CPU staging contents.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pixels } from './png.mjs';
const output = resolve(process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/retained-rows');
const harness = await readFile(resolve('demo/compare.js'), 'utf8');
const helperStart = harness.indexOf('  /** Untimed incremental correctness fixture.');
const helperEnd = harness.indexOf('  text: () => active.text(),', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, 'Incremental fixture helper is missing');
const fixtureHelper = harness.slice(helperStart, helperEnd);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const checks = [];
try {
  for (const dpr of [1, 2])
    for (const type of ['wraith', 'ghostty']) {
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1200 },
        deviceScaleFactor: dpr,
      });
      const pages = [];
      const errors = [];
      for (const url of [
        process.env.WRAITH_BEFORE_URL ?? 'http://127.0.0.1:5190',
        process.env.WRAITH_URL ?? 'http://127.0.0.1:5173',
      ]) {
        const page = await context.newPage();
        pages.push(page);
        page.on('pageerror', (e) => errors.push(e.message));
        // Old Git archives do not expose the incremental test helper. Inject
        // only that untimed helper, preserving their renderer and engine.
        await page.route('**/compare.js*', async (route) => {
          const response = await route.fetch();
          let body = await response.text();
          if (!body.includes('async step(')) {
            assert(body.includes('  adapterInfo,'), 'Baseline harness has an unknown layout');
            body = body.replace('  adapterInfo,', '  adapterInfo,\n' + fixtureHelper);
          }
          await route.fulfill({ response, body });
        });
        await page.goto(`${url}/compare.html?type=${type}`);
        await page.waitForFunction(() => window.comparison?.ready);
        assert(await page.evaluate(() => window.comparison.ready));
        await page.evaluate(
          (type) => window.comparison.setup({ type, workload: 'complex', cols: 96, rows: 12 }),
          type,
        );
        await page.addStyleTag({
          content: '.xterm-scrollable-element > .scrollbar { visibility: hidden !important; }',
        });
      }
      const cases = [
        {
          label: 'unique styled rows',
          data:
            '\x1bc\x1b[?25l' +
            Array.from(
              { length: 20 },
              (_, y) => `\x1b[3${y % 8}mrow ${y} ${'ABCDEFGHIJKLMN'.repeat(4)}\x1b[0m`,
            ).join('\r\n'),
        },
        { label: 'one-line scroll', data: '\r\nnew retained row' },
        ...(type === 'wraith'
          ? [{ label: 'legacy partial upload into rotated GPU slots', legacyUpload: true }]
          : []),
        { label: 'cursor-only change', data: '\x1b[2;2H' },
        { label: 'disjoint edits', data: '\x1b[1;1Htop\x1b[12;1Hbottom' },
        {
          label: 'insert and delete within margins',
          data: '\x1b[3;10r\x1b[4;1H\x1b[L\x1b[8;1H\x1b[M\x1b[r',
        },
        { label: 'reverse index', data: '\x1b[H\x1bM' },
        {
          label: 'duplicate blank rows and independent edits',
          data: '\x1b[2J\x1b[H\x1b[2;1Hduplicate\x1b[4;1Hduplicate\x1b[8;1Hchanged',
        },
        {
          label: 'wide combining emoji and extended underlines',
          data: '\x1b[3;1H界é 🦀\x1b[4:3;58:2::255:0:0mcurly\x1b[0m',
        },
        { label: 'alternate screen', data: '\x1b[?1049h\x1b[Halternate\r\nsecond row' },
        { label: 'normal screen restored', data: '\x1b[?1049l' },
        { label: 'viewport backward', scroll: -4 },
        { label: 'viewport forward', scroll: 2 },
        {
          label: 'selection over moved rows',
          selection: type === 'wraith' ? [1, 2, 20] : [1, 2, 20, 3],
        },
        { label: 'selection removed', data: '\x1b[1;1H' },
        ...(type === 'wraith'
          ? [{ label: 'atlas reset after row rotation', atlasReset: true }]
          : []),
      ];
      for (const fixture of cases) {
        const shots = [],
          texts = [];
        for (const page of pages) {
          texts.push(await page.evaluate((f) => window.comparison.step(f), fixture));
          shots.push(pixels(await page.locator('#scene canvas').first().screenshot()));
        }
        assert.equal(texts[1], texts[0], `${type} DPR${dpr} ${fixture.label}: text`);
        assert.deepEqual([shots[1].width, shots[1].height], [shots[0].width, shots[0].height]);
        let differing = 0;
        for (let i = 0; i < shots[0].data.length; i++)
          if (shots[0].data[i] !== shots[1].data[i]) differing++;
        checks.push({ type, dpr, label: fixture.label, differing });
        assert.equal(differing, 0, `${type} DPR${dpr} ${fixture.label}: GPU pixels changed`);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
} finally {
  await browser.close();
}
await writeFile(resolve(output, 'incremental-pixels.json'), JSON.stringify(checks, null, 2) + '\n');
console.log(
  `${checks.length} incremental retained-row frames have byte-identical pixels and text.`,
);
