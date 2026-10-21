import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { createHash } from 'node:crypto';
const root = process.env.WRAITH_SOURCE_ROOT ?? process.cwd();
const url = process.env.WRAITH_URL ?? 'http://127.0.0.1:5196';
const output = process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/native-search/after';
const types = (process.env.WRAITH_TYPES ?? 'dom,webgl,wraith,ghostty').split(',');
const allowMismatch = process.env.WRAITH_ALLOW_MISMATCH === '1';
const repeats = Number(process.env.WRAITH_REPETITIONS ?? 5);
const cases = [
  { lines: 9000, wrapped: false },
  { lines: 9000, wrapped: true },
  { lines: 90000, wrapped: false },
];
const sourceFiles = [
  'packages/wraith/src/worker.ts',
  'native/bridge.c',
  'packages/wraith/wasm/wraith_engine_bg.wasm',
  'demo/interaction-bench.js',
  'scripts/search-benchmark.mjs',
];
const sources = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(`${root}/${file}`))
          .digest('hex'),
      ]),
    ),
  );
const report = {
  date: new Date().toISOString(),
  head:
    process.env.WRAITH_BUILD_HASH ??
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sources: await sources(),
  cpu: cpus()[0].model,
  logicalCpus: cpus().length,
  os: `${process.platform} ${release()}`,
  xterm: JSON.parse(await readFile('node_modules/@xterm/xterm/package.json')).version,
  searchAddon: JSON.parse(await readFile('node_modules/@xterm/addon-search/package.json')).version,
  config: { url, types, repeats, cases },
  results: [],
  methodology:
    'Production builds, public SDK. Rotated renderer order. New terminal per case/repetition; 9 different cold needles and 24 same-needle navigations. all-count validates exact totals on both paths; upstream xterm additionally creates offscreen/onscreen decorations while native selects one match. next-only is xterm without full count; native always returns all counts. Timing stops at API completion, not GPU/display completion. Text selection and counts validated outside timed region. Unicode/cell wrap fixture is not a glyph-conformance claim. Native worker round trip included. Browser timer resolution applies. No concurrent benchmark.',
};
await mkdir(output, { recursive: true });
const save = () => writeFile(`${output}/runs.json`, JSON.stringify(report, null, 2) + '\n');
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1200 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url + '/compare.html');
  await page.waitForFunction(() => window.comparison?.interactions?.searchTimings);
  report.userAgent = await page.evaluate(() => navigator.userAgent);
  for (const fixture of cases)
    for (let repeat = 0; repeat < repeats; repeat++) {
      const order = [
        ...types.slice(repeat % types.length),
        ...types.slice(0, repeat % types.length),
      ];
      for (const type of order) {
        await page.evaluate(
          async ({ type, fixture }) => {
            await window.comparison.ready;
            await window.comparison.interactionSetup(type, {
              cols: 120,
              rows: 40,
              scrollback: fixture.lines * 3,
              highlightLimit: 1000,
            });
            window.searchQueries = await window.comparison.interactions.searchFixture(fixture);
          },
          { type, fixture },
        );
        for (const mode of ['all-count', 'next-only', 'navigation']) {
          const result = await page.evaluate(
            async ({ mode, allowMismatch }) =>
              window.comparison.interactions.searchTimings({
                queries:
                  mode === 'navigation'
                    ? Array.from({ length: 24 }, () => window.searchQueries[0])
                    : window.searchQueries,
                count: mode !== 'next-only',
                navigation: mode === 'navigation',
                allowMismatch,
              }),
            { mode, allowMismatch },
          );
          report.results.push({ type, fixture, repeat, mode, ...result });
          console.log(JSON.stringify({ type, ...fixture, repeat, mode, ...result.summary }));
          await save();
        }
        await page.evaluate(() => window.comparison.interactions.interactionDispose());
      }
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(await sources(), report.sources, 'Sources changed during timings');
} finally {
  await save();
  await browser.close();
}
