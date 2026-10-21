import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { pixels } from './png.mjs';
const urls = [
  process.env.WRAITH_BEFORE_URL ?? 'http://127.0.0.1:5197',
  process.env.WRAITH_URL ?? 'http://127.0.0.1:5198',
];
const output = process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/selection-retention';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const checks = [],
  errors = [];
let userAgent;
const sourceRoot = process.env.WRAITH_SOURCE_ROOT ?? process.cwd();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sources = Object.fromEntries(
  await Promise.all(
    ['packages/wraith/src/xterm-renderer.ts', 'packages/wraith/wasm/wraith_engine_bg.wasm'].map(
      async (path) => [path, hash(await readFile(sourceRoot + '/' + path))],
    ),
  ),
);
try {
  const pages = [];
  for (const url of urls) {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
      deviceScaleFactor: 1,
    });
    pages.push(page);
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url + '/xterm.html');
    userAgent ??= await page.evaluate(() => navigator.userAgent);
    await page.waitForFunction(() => window.compat?.term.renderer === 'webgpu');
    await page.evaluate(async () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#181818';
      document.body.append(host);
      const term = new window.compat.Terminal({
        cols: 80,
        rows: 24,
        fontSize: 15,
        fontFamily: 'monospace',
        allowProposedApi: true,
        minimumContrastRatio: 1,
        cursorBlink: false,
      });
      term.open(host);
      await term.webgpuReady;
      const renderer = term._core._renderService._renderer.value;
      const write = (data) => new Promise((r) => term.write(data, r));
      const draw = async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        renderer.renderRows(0, 23);
        await renderer.gpu.fence();
      };
      await write(
        '\x1b[?25l' +
          Array.from(
            { length: 24 },
            (_, y) =>
              `\x1b[3${(y % 7) + 1}mrow ${y} ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz\x1b[0m`,
          ).join('\r\n'),
      );
      await draw();
      window.retention = { term, renderer, write, draw };
    });
  }
  for (const fixture of [
    { label: 'one-line public scroll', data: '\r\nnext abcdefghijklmnopqrstuvwxyz' },
    { label: 'five-line public scroll', data: '\r\nnext abcdefghijklmnopqrstuvwxyz'.repeat(5) },
    { label: 'selection', select: true },
    { label: 'identical selection refresh', repeatSelection: true },
    { label: 'clear selection', clear: true },
    { label: 'empty selection refresh', empty: true },
    { label: 'scroll after selection clearing', data: '\r\nnext abcdefghijklmnopqrstuvwxyz' },
  ]) {
    const samples = [],
      shots = [];
    for (const page of pages) {
      const sample = await page.evaluate(async (f) => {
        const { term, renderer: r, write, draw } = window.retention;
        const before = Number(r.gpu.cell_upload_bytes);
        if (f.data) await write(f.data);
        if (f.select) term.select(1, term.buffer.active.baseY + 2, 8);
        if (f.repeatSelection)
          r.handleSelectionChanged(
            [1, term.buffer.active.baseY + 2],
            [9, term.buffer.active.baseY + 2],
            false,
          );
        if (f.clear) term.clearSelection();
        if (f.empty) r.handleSelectionChanged(undefined, undefined, false);
        await draw();
        return {
          bytes: Number(r.gpu.cell_upload_bytes) - before,
          text: Array.from({ length: 24 }, (_, y) =>
            term.buffer.active.getLine(term.buffer.active.viewportY + y).translateToString(true),
          ).join('\n'),
          renderer: term.renderer,
        };
      }, fixture);
      assert.equal(sample.renderer, 'webgpu');
      samples.push(sample);
      shots.push(pixels(await page.locator('.wraith-xterm-webgpu').last().screenshot()));
    }
    assert.equal(samples[0].text, samples[1].text);
    assert.equal(shots[0].width, shots[1].width);
    assert.equal(shots[0].height, shots[1].height);
    assert.deepEqual(shots[0].data, shots[1].data, fixture.label + ' pixels');
    if (fixture.empty) assert.equal(samples[1].bytes, 0, fixture.label + ' must upload no cells');
    if (fixture.repeatSelection)
      assert(samples[1].bytes <= 80 * 20, fixture.label + ' only repacks the selected row');
    if (fixture.data)
      assert(samples[1].bytes < samples[0].bytes, fixture.label + ' retains moved rows');
    checks.push({
      label: fixture.label,
      beforeBytes: samples[0].bytes,
      afterBytes: samples[1].bytes,
      pixelDifferences: 0,
    });
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
await writeFile(
  output + '/validation.json',
  JSON.stringify(
    {
      date: new Date().toISOString(),
      urls,
      checks,
      userAgent,
      cpu: cpus()[0].model,
      logicalCpus: cpus().length,
      grid: [80, 24],
      dpr: 1,
      build: process.env.WRAITH_BUILD_HASH ?? null,
      beforeBuild: process.env.WRAITH_BEFORE_HASH ?? null,
      sources,
      harnessSha256: hash(await readFile(new URL(import.meta.url))),
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ checks }, null, 2));
