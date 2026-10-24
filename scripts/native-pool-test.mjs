// Terminal pool: many native terminals share a few workers and WebGPU devices,
// yet render, resize, search, fail and dispose independently.
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
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.WRAITH_URL ?? 'http://127.0.0.1:5173/playground.html');
  await page.waitForFunction(() => window.wraith);
  const count = 64;
  const mounted = await page.evaluate(async (count) => {
    const Wraith = window.wraith.constructor;
    const grid = document.createElement('div');
    grid.id = 'pool-grid';
    grid.style.cssText =
      'position:fixed;inset:0;display:grid;grid-template-columns:repeat(8,1fr);z-index:10000;background:#000';
    document.body.append(grid);
    const pool = (window.pool = Wraith.pool({ workers: 4 }));
    const started = performance.now();
    window.terms = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const host = document.createElement('div');
        host.style.cssText = 'height:125px;overflow:hidden';
        grid.append(host);
        const term = await Wraith.mount(host, { cols: 20, rows: 6, fit: false, fontSize: 9, pool });
        // A distinct solid background per terminal, plus text to search for.
        const hue = (i * 37) % 360;
        const [r, g, b] = [0, 120, 240].map((s) =>
          Math.round(127 + 127 * Math.cos(((hue + s) * Math.PI) / 180)),
        );
        await term.write(`\x1b[48;2;${r};${g};${b}m\x1b[2J\x1b[Hterm-${i} needle-${i}`);
        await term.flush();
        return term;
      }),
    );
    return { ms: performance.now() - started, load: pool.load };
  }, count);
  assert.equal(mounted.load.length, 4, 'four workers');
  assert.deepEqual(mounted.load, [16, 16, 16, 16], 'least-loaded assignment');

  // Every terminal draws its own color in its own canvas.
  const image = pixels(await page.locator('#pool-grid').screenshot());
  const boxes = await page.evaluate(() =>
    window.terms.map((t) => {
      const r = t.canvas.getBoundingClientRect();
      return [Math.floor(r.left + r.width * 0.7), Math.floor(r.top + r.height * 0.8)];
    }),
  );
  const colors = new Set(
    boxes.map(([x, y]) => {
      const i = (y * image.width + x) * image.bpp;
      return `${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`;
    }),
  );
  assert(colors.size >= 9, `distinct pooled canvases: ${colors.size} colors`);

  // Text, search and resize stay per terminal.
  const state = await page.evaluate(async () => {
    const [a, b] = [window.terms[5], window.terms[42]];
    await a.resize(30, 4);
    const found = await b.findNext('needle-42');
    const missing = await b.findNext('needle-5');
    return {
      a: (await a.getText()).trim(),
      b: (await b.getText()).trim(),
      size: [a.cols, a.rows, b.cols, b.rows],
      found: found.total,
      missing: missing.total,
    };
  });
  assert.match(state.a, /term-5 needle-5/);
  assert.match(state.b, /term-42 needle-42/);
  assert.deepEqual(state.size, [30, 4, 20, 6]);
  assert.equal(state.found, 1);
  assert.equal(state.missing, 0);

  // Disposing half leaves the rest working; the pool rebalances new terminals.
  const after = await page.evaluate(async () => {
    const pool = window.pool;
    await Promise.all(window.terms.filter((_, i) => i % 2).map((t) => t.dispose()));
    const survivor = window.terms[10];
    await survivor.write('\r\nstill alive');
    await survivor.flush();
    const load = pool.load;
    const host = document.createElement('div');
    document.body.append(host);
    const late = await window.wraith.constructor.mount(host, {
      cols: 20,
      rows: 4,
      fit: false,
      pool,
    });
    await late.write('late');
    const lateText = await late.getText();
    return { load, text: await survivor.getText(), lateText, loadAfter: pool.load };
  });
  // Terminals were placed round-robin, so odd ones shared workers 2 and 4.
  assert.deepEqual(after.load, [16, 0, 16, 0]);
  assert.deepEqual(after.loadAfter, [16, 1, 16, 0], 'new terminal fills the emptiest worker');
  assert.match(after.text, /still alive/);
  assert.match(after.lateText, /late/);
  assert.equal(
    after.loadAfter.reduce((a, b) => a + b),
    33,
  );

  // A failing terminal does not take its neighbours down.
  const isolated = await page.evaluate(async () => {
    const pool = window.wraith.constructor.pool({ workers: 1 });
    const make = async () => {
      const host = document.createElement('div');
      document.body.append(host);
      return window.wraith.constructor.mount(host, { cols: 10, rows: 3, fit: false, pool });
    };
    const [a, b] = [await make(), await make()];
    const failed = await Promise.allSettled([a.resize(10_000, 10_000)]);
    await b.write('fine');
    const text = await b.getText();
    await a.dispose();
    await b.dispose();
    pool.dispose();
    return { failed: failed[0].status, text };
  });
  assert.equal(isolated.failed, 'rejected');
  assert.match(isolated.text, /fine/);

  await page.evaluate(async () => {
    await Promise.all(window.terms.map((t) => t.dispose()));
    window.pool.dispose();
  });
  assert.deepEqual(errors, []);
  console.log(
    `Pool passed: ${count} terminals on 4 workers mounted in ${mounted.ms.toFixed(0)} ms; distinct pixels, per-terminal resize/search/text, rebalanced disposal, failure isolation.`,
  );
} finally {
  await browser.close();
}
