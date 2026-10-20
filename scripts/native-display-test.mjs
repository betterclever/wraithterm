import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { pixelSummary } from './png.mjs';

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
  const initial = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'display-terminal';
    host.style.cssText =
      'position:fixed;left:0;top:0;width:900px;height:600px;background:black;z-index:10000';
    document.body.append(host);
    const term = (window.displayTerm = await window.wraith.constructor.mount(host, {
      cols: 30,
      rows: 6,
      fit: false,
    }));
    await term.write('history\r\nhello world\r\n\x1b[?2004h');
    await term.selectWord(2, 1);
    await term.flush();
    window.displayWorker = term.worker;
    return {
      text: await term.getText(),
      width: parseFloat(term.canvas.style.width),
      height: parseFloat(term.canvas.style.height),
    };
  });
  const changed = await page.evaluate(async () => {
    const term = window.displayTerm;
    await term.setFontSize(20);
    await term.flush();
    const larger = {
      width: parseFloat(term.canvas.style.width),
      height: parseFloat(term.canvas.style.height),
    };
    const selected = await term.getText(true);
    const invalidSize = await Promise.allSettled([term.setFontSize(Infinity)]);
    const invalidFont = await Promise.allSettled([term.setFont(new Uint8Array([1, 2, 3]))]);
    await term.setFont(new URL('/fonts/JetBrainsMono-Regular.ttf', location.href), {
      fontSize: 16,
      lineHeight: 1.5,
    });
    await term.flush();
    return {
      larger,
      selected,
      invalidSize: invalidSize[0].status,
      invalidFont: invalidFont[0].status,
      text: await term.getText(),
      sameWorker: term.worker === window.displayWorker,
      width: parseFloat(term.canvas.style.width),
      height: parseFloat(term.canvas.style.height),
    };
  });
  assert(changed.larger.width > initial.width && changed.larger.height > initial.height);
  assert.equal(changed.selected, 'hello');
  assert.equal(changed.invalidSize, 'rejected');
  assert.equal(changed.invalidFont, 'rejected');
  assert.equal(changed.text, initial.text);
  assert.equal(changed.sameWorker, true);
  const cdp = await page.context().newCDPSession(page);
  for (const dpr of [2, 1]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1200,
      height: 900,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    await page
      .waitForFunction((scale) => window.displayTerm.dpr === scale, dpr, { timeout: 5000 })
      .catch(async (error) => {
        console.log(
          await page.evaluate(() => ({
            dpr: devicePixelRatio,
            native: window.displayTerm.dpr,
            query: window.displayTerm.dprQuery?.media,
            matches: window.displayTerm.dprQuery?.matches,
          })),
        );
        throw error;
      });
    const state = await page.evaluate(async () => {
      const term = window.displayTerm;
      await term.flush();
      return {
        cols: term.cols,
        rows: term.rows,
        width: term.cols * term.cellWidth,
        height: term.rows * term.cellHeight,
        cssHeight: parseFloat(term.canvas.style.height),
        text: await term.getText(),
        selected: await term.getText(true),
        sameWorker: term.worker === window.displayWorker,
      };
    });
    assert.equal(state.cols, 30);
    assert.equal(state.rows, 6);
    assert.equal(state.height, changed.height * dpr);
    assert.equal(state.cssHeight, changed.height);
    assert.equal(state.text, initial.text);
    assert.equal(state.selected, 'hello');
    assert.equal(state.sameWorker, true);
  }
  const pixels = pixelSummary(await page.locator('#display-terminal canvas').screenshot());
  assert(pixels.colors > 3 && pixels.bright > 100, JSON.stringify(pixels));
  const mode = await page.evaluate(async () => {
    const term = window.displayTerm;
    const bytes = [];
    const listener = term.onBytes((data) => bytes.push(...data));
    await term.paste('test');
    listener.dispose();
    const found = await term.findNext('history');
    await term.dispose();
    return { output: String.fromCharCode(...bytes), found };
  });
  assert.equal(mode.output, '\x1b[200~test\x1b[201~');
  assert.equal(mode.found.total, 1);
  const fitted = await page.evaluate(async () => {
    const term = await window.wraith.constructor.mount(
      document.querySelector('#display-terminal'),
      { fontSize: 12 },
    );
    await term.write('fitted terminal');
    await term.flush();
    const before = term.cols;
    await term.setFontSize(24);
    await term.flush();
    const after = term.cols;
    const text = await term.getText();
    await term.dispose();
    return { before, after, text };
  });
  assert(fitted.after < fitted.before);
  assert.match(fitted.text, /fitted terminal/);
  assert.deepEqual(errors, []);
  console.log(
    'Live display passed: zoom, atomic font rejection/replacement, DPR 1↔2, GPU pixels, worker/content/selection/history/mode preservation.',
  );
} finally {
  await browser.close();
}
