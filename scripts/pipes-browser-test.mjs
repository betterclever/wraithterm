import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pixelSummary } from './png.mjs';

const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const output = resolve(process.env.WRAITH_REPORT_DIR ?? '.cache/pipes');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const checks = [],
  errors = [];
async function ready(page) {
  await page.waitForFunction(
    () =>
      window.pipesLab?.error ||
      (window.pipesLab?.state.ready && window.pipesLab.state.stats?.completed > 0),
    undefined,
    { timeout: 60000 },
  );
  assert.equal(await page.evaluate(() => window.pipesLab.error), undefined);
  return page.evaluate(() => window.pipesLab.state);
}
try {
  for (const renderer of ['wraith', 'webgl', 'dom']) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1250 },
      deviceScaleFactor: 1,
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`${base}/pipes.html?renderer=${renderer}&source=replay&paused=1`);
    const state = await ready(page);
    assert.equal(state.frames, 48);
    assert.equal(state.running, false);
    assert.equal(state.terminalLines, state.rows);
    assert.equal(state.renderer, renderer === 'wraith' ? 'webgpu' : renderer);
    assert(state.bankBytes < 40 * 1048576);
    const png = await page.locator('#viewport').screenshot();
    const pixels = pixelSummary(png);
    assert(pixels.colors > 500 && pixels.bright > 5000, 'Scene must contain shaded geometry');
    await writeFile(join(output, `${renderer}.png`), png);
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
      'rgb(12, 8, 6)',
    );
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--amber').trim()),
      '#ffb86b',
    );
    await page.locator('#pause').click();
    await page.waitForFunction(() => window.pipesLab.state.stats.completed >= 12);
    // Unapplied controls must not mutate the active worker/player protocol.
    await page.selectOption('#source', 'live');
    const previous = await page.evaluate(() => window.pipesLab.state.stats.completed);
    await page.waitForFunction((n) => window.pipesLab.state.stats.completed >= n + 4, previous);
    assert.equal(await page.evaluate(() => window.pipesLab.state.source), 'replay');
    await page.locator('#pause').click();
    await page.waitForFunction(() => !window.pipesLab.state.inFlight);
    const paused = await page.evaluate(() => window.pipesLab.state.stats.completed);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.pipesLab.state.stats.completed), paused);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download').click();
    const download = await downloadPromise;
    const bytes = await readFile(await download.path());
    assert(bytes.includes(Buffer.from('▀')) && bytes.includes(Buffer.from('\x1b[38;2;')));
    assert(bytes.subarray(-16).toString().endsWith('\x1b[?25h'));
    // Rebuild into the worker path, then switch during an unfinished bake.
    await page.locator('#apply').click();
    await ready(page);
    assert.equal(await page.evaluate(() => window.pipesLab.state.source), 'live');
    await page.locator('#pause').click();
    await page.waitForFunction(() => window.pipesLab.state.stats.completed >= 6);
    await page.selectOption('#source', 'replay');
    await page.selectOption('#preset', 'inferno');
    await page.locator('#apply').click();
    await page.selectOption('#preset', 'classic');
    await page.locator('#apply').click();
    const rebuilt = await ready(page);
    assert.equal(rebuilt.cols, 120);
    assert.equal(rebuilt.rows, 42);
    assert.equal(rebuilt.frames, 48);
    checks.push({
      renderer,
      pixels,
      bankBytes: state.bankBytes,
      scene: state.scene,
      checks: [
        'ember theme',
        '48-frame bounded replay',
        'public write/render animation',
        'pending controls',
        'pause',
        'ANSI download',
        'live worker',
        'rebuild cancellation',
      ],
    });
    await page.close();
  }
  for (const renderer of ['wraith', 'webgl', 'dom']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1250 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.install();
    await page.goto(`${base}/pipes.html?renderer=${renderer}&pipes=1`);
    let state = await ready(page);
    assert.equal(state.source, 'growth');
    assert.equal(state.frames, 0);
    assert.equal(state.bankBytes, 0);
    assert.equal(state.stats.growth.pipeCount, 1);
    const firstTriangles = state.scene.triangles;
    await page.clock.fastForward(8000);
    await page.waitForFunction(() => window.pipesLab.state.stats.growth.progress >= 0.45);
    state = await page.evaluate(() => window.pipesLab.state);
    assert(state.scene.triangles > firstTriangles, 'Single tube must extend');
    await page.locator('#pause').click();
    await page.waitForFunction(
      () => !window.pipesLab.state.inFlight && !window.pipesLab.state.workerPending,
    );
    const paused = await page.evaluate(() => window.pipesLab.state.stats.growth);
    await page.clock.fastForward(30000);
    assert.deepEqual(await page.evaluate(() => window.pipesLab.state.stats.growth), paused);
    await page.screenshot({ path: join(output, `xp-single-${renderer}.png`), fullPage: true });
    await page.locator('#pause').click();
    await page.clock.fastForward(10000);
    await page.waitForFunction(() => window.pipesLab.state.stats.growth.cycle >= 1);
    assert.equal(await page.evaluate(() => window.pipesLab.state.stats.growth.pipeCount), 1);
    await page.locator('#pipes').fill('6');
    const reset = await page.evaluate(() => {
      document.getElementById('apply').click();
      return window.pipesLab.state;
    });
    assert.equal(reset.ready, false);
    assert.equal(reset.stats, undefined, 'Rebuild must clear previous frame statistics');
    assert.equal(reset.scene, undefined, 'Rebuild must clear previous scene statistics');
    state = await ready(page);
    assert.equal(state.stats.growth.pipeCount, 6);
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => window.pipesLab.state.stats.growth.progress >= 0.3);
    await page.locator('#pause').click();
    await page.waitForFunction(() => !window.pipesLab.state.inFlight);
    await page.screenshot({ path: join(output, `xp-multiple-${renderer}.png`), fullPage: true });
    checks.push({
      renderer,
      checks: [
        'XP default with one pipe',
        'continuous tube growth',
        'pause freezes growth clock',
        'automatic cycle reset',
        'six simultaneous growing pipes',
        'no replay allocation',
      ],
    });
    await page.close();
  }
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(`${base}/pipes.html?preset=classic`);
  const state = await ready(mobile);
  assert.equal(state.running, false, 'Reduced motion starts paused');
  assert(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Mobile horizontal overflow',
  );
  await mobile.screenshot({ path: join(output, 'mobile.png'), fullPage: true });
  checks.push({
    renderer: 'wraith',
    checks: ['390px responsive layout', 'DPR2', 'reduced motion starts paused'],
  });
  await mobile.close();
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1300 } });
  await desktop.goto(`${base}/pipes.html?preset=inferno&source=replay&paused=1`);
  await ready(desktop);
  await desktop.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
  await desktop.close();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
await writeFile(
  join(output, 'validation.json'),
  JSON.stringify({ date: new Date().toISOString(), checks, errors }, null, 2) + '\n',
);
console.log(
  `Pipes lab verified in all three renderers, live/replay, desktop/mobile, with no browser errors. ${output}`,
);
