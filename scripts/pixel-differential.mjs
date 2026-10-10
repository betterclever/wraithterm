// Renders identical scenes and fixtures through a baseline build and the
// current build, then requires byte-identical screenshots. Use it for renderer
// changes that alter internal layouts, where packed-word comparisons cannot apply.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pixels } from './png.mjs';
const output = resolve(process.env.WRAITH_REPORT_DIR ?? '.cache/pixel-differential');
await mkdir(output, { recursive: true });
const versions = [
  { name: 'before', url: process.env.WRAITH_BEFORE_URL ?? 'http://127.0.0.1:5190' },
  { name: 'after', url: process.env.WRAITH_URL ?? 'http://127.0.0.1:5173' },
];
const sgr = (codes, text) => `\x1b[${codes}m${text}\x1b[0m`;
const fixtures = [
  {
    label: 'underline styles, colors, strike and overline on glyphs and blanks',
    data:
      [1, 2, 3, 4, 5]
        .map((n) => sgr(`4:${n};58:2::255:${n * 40}:0`, `under${n}   `) + ' ')
        .join('') +
      '\r\n' +
      sgr('9', 'strike   ') +
      sgr('53', 'overline   ') +
      sgr('4;9;53;38;5;208', 'all   ') +
      sgr('4', '        '),
  },
  ...[
    ['steady block', 2],
    ['underline', 4],
    ['bar', 6],
  ].flatMap(([name, style]) => [
    {
      label: `${name} cursor on a blank cell`,
      data: `\x1b[${style} qprompt$ `,
    },
    {
      label: `${name} cursor on a glyph`,
      data: `\x1b[${style} qprompt$ Wxyz\x1b[3D`,
    },
  ]),
  {
    label: 'hollow cursor on an unfocused terminal',
    data: 'prompt$ Wxyz\x1b[2D',
    focus: false,
    types: ['wraith'],
  },
  {
    label: 'italic and bold overhang, wide, combining and color emoji',
    data:
      sgr('3', 'fffWWWjjj///') +
      ' ' +
      sgr('1;3', 'MWfj') +
      '\r\n界面漢字 éä 🦀🚀 ' +
      sgr('4', '界🦀') +
      '\r\n' +
      sgr('7', ' inverse ') +
      sgr('2', ' dim ') +
      sgr('8', ' hidden ') +
      sgr('5', ' blink '),
  },
  {
    label: 'background-only erased cells, inverse erase and default-styled runs',
    data:
      'plain\x1b[48;5;21m\x1b[K\r\n' +
      '\x1b[48;2;90;30;10mrgb\x1b[K\x1b[0m\r\n' +
      '\x1b[7;48;5;160mINV\x1b[5X\x1b[0m tail\r\n' +
      '\x1b[38;5;40;4mA\x1b[0mB\x1b[38;5;40;4mC\x1b[0m',
  },
  {
    label: 'box drawing, block elements, shades and braille',
    data:
      '┌─┬─┐│▀▄█▌▐░▒▓▖▗▘▙▚▛▜▝▞▟\r\n├─┼─┤ ⠁⠃⠇⡇⣇⣧⣷⣿ ▁▂▃▄▅▆▇█\r\n└─┴─┘',
  },
  {
    label: 'selection across styles and wide cells',
    data: sgr('1;31', 'AAAA') + 'BB界B' + sgr('7;38;5;21', 'CCCC') + '\r\nsecond line',
    selection: [2, 0, 20],
    nativeSelection: [2, 0, 5, 1],
    options: { theme: { selectionBackground: '#335577', selectionForeground: '#ffeecc' } },
  },
];
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const checks = [];
try {
  for (const dpr of [1, 2])
    for (const type of ['wraith', 'ghostty'])
      for (const workload of ['complex', 'churn', 'scroll']) {
        const cases = workload === 'complex' ? [undefined, ...fixtures] : [undefined];
        const shots = new Map();
        for (const version of versions) {
          const context = await browser.newContext({
            viewport: { width: 2600, height: 2100 },
            deviceScaleFactor: dpr,
          });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(`${version.url}/compare.html?type=${type}&workload=${workload}`);
          await page.waitForFunction(() => window.comparison?.ready, undefined, {
            timeout: 30000,
          });
          assert(await page.evaluate(() => window.comparison.ready));
          // xterm's DOM scrollbar overlays the canvas and fades on a timer.
          await page.addStyleTag({
            content: '.xterm-scrollable-element > .scrollbar { visibility: hidden !important; }',
          });
          for (const fixture of cases) {
            if (fixture?.types && !fixture.types.includes(type)) continue;
            const label = fixture?.label ?? `${workload} scene`;
            let text;
            if (fixture)
              text = await page.evaluate((f) => window.comparison.fixture(f), {
                ...fixture,
                selection: type === 'ghostty' ? fixture.nativeSelection : fixture.selection,
              });
            const png = await page.locator('#scene canvas').first().screenshot();
            shots.set(`${version.name}:${label}`, { png, text });
          }
          assert.deepEqual(errors, [], `${version.name} page errors`);
          await context.close();
        }
        for (const fixture of cases) {
          if (fixture?.types && !fixture.types.includes(type)) continue;
          const label = fixture?.label ?? `${workload} scene`;
          const before = shots.get(`before:${label}`),
            after = shots.get(`after:${label}`);
          const a = pixels(before.png),
            b = pixels(after.png);
          assert.equal(after.text, before.text, `${type} DPR${dpr} ${label}: text`);
          assert.equal(b.width, a.width);
          assert.equal(b.height, a.height);
          let differing = 0;
          for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) differing++;
          const name = `${type}-dpr${dpr}-${label.replace(/\W+/g, '-')}`;
          if (differing) {
            await writeFile(resolve(output, `${name}-before.png`), before.png);
            await writeFile(resolve(output, `${name}-after.png`), after.png);
          }
          checks.push({ type, dpr, label, width: a.width, height: a.height, differing });
          console.log(`${differing ? 'DIFF' : 'same'} ${type} DPR${dpr} ${label} (${differing} bytes)`);
        }
      }
} finally {
  await browser.close();
}
await writeFile(resolve(output, 'pixel-differential.json'), JSON.stringify(checks, null, 2) + '\n');
const failed = checks.filter((c) => c.differing);
assert.equal(failed.length, 0, `${failed.length} pixel differentials differ`);
console.log(`${checks.length} scenes and fixtures are byte-identical to the baseline.`);
