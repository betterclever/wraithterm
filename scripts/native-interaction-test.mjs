import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
  args:
    process.env.WRAITH_SOFTWARE_GPU === '1'
      ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader']
      : [],
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
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'interaction-terminal';
    host.style.cssText =
      'position:fixed;left:0;top:0;width:800px;height:400px;background:black;z-index:10000';
    document.body.append(host);
    window.featureTerm = await window.wraith.constructor.mount(host, {
      cols: 24,
      rows: 4,
      fit: false,
    });
  });
  const state = await page.evaluate(async () => {
    const term = window.featureTerm;
    // Search must flush a write made in this same JavaScript task.
    const written = term.write('old MATCH\r\n界 match\r\nthird MATCH\r\nlatest\r\nend');
    const first = await term.findNext('match');
    await written;
    const next = await term.findNext('match');
    const previous = await term.findPrevious('match');
    const matched = await term.getText(true);
    const unicode = await term.findNext('界');
    const unicodeText = await term.getText(true);
    await term.clearSearch();
    const cleared = await term.getText(true);
    const missing = await term.findNext('not-present');
    await term.clearSearch();
    await term.resize(12, 5);
    const reflow = await term.findNext('match');
    await term.clearSearch();
    await term.selectAll();
    const all = await term.getText(true);
    await term.clearSelection();
    const cancelled = await Promise.allSettled([term.findNext('old'), term.findNext('end')]);
    await term.clearSearch();
    return {
      first,
      next,
      previous,
      matched,
      unicode,
      unicodeText,
      cleared,
      missing,
      reflow,
      all,
      cancelled: cancelled.map((r) => r.status),
    };
  });
  assert.equal(state.first.total, 3);
  assert.equal(state.first.index, 0);
  assert.equal(state.next.index, 1);
  assert.equal(state.previous.index, 0);
  assert.match(state.matched, /MATCH/i);
  assert.equal(state.unicode.total, 1);
  assert.equal(state.unicodeText, '界');
  assert.equal(state.cleared, '');
  assert.deepEqual(state.missing, { total: 0, index: -1 });
  assert.equal(state.reflow.total, 3);
  assert.match(state.all, /old MATCH/);
  assert.deepEqual(state.cancelled, ['rejected', 'fulfilled']);

  await page.evaluate(async () => {
    await window.featureTerm.resize(24, 4);
    window.featureTerm.scroll(10000);
    await window.featureTerm.write('\x1b[2J\x1b[Hhello world\r\nsecond line\r\nthird');
    await window.featureTerm.flush();
  });
  const canvas = page.locator('#interaction-terminal canvas');
  const box = await canvas.boundingBox();
  const cellX = box.width / 24,
    cellY = box.height / 4;
  await page.mouse.dblclick(box.x + cellX * 2.5, box.y + cellY * 0.5);
  assert.equal(await page.evaluate(() => window.featureTerm.getText(true)), 'hello');
  await page.mouse.click(box.x + cellX * 3.5, box.y + cellY * 1.5, { clickCount: 3 });
  assert.equal(await page.evaluate(() => window.featureTerm.getText(true)), 'second line');
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x + cellX * 0.5, box.y + cellY * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + cellX * 1.5, box.y + cellY * 2.5, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  assert.equal(await page.evaluate(() => window.featureTerm.getText(true)), 'he\nse\nth');

  await page.evaluate(() => {
    window.inputBytes = [];
    window.inputSubscription = window.featureTerm.onBytes((bytes) =>
      window.inputBytes.push(...bytes),
    );
    window.keyHook = window.featureTerm.attachCustomKeyEventHandler((event) => event.key !== 'q');
    window.featureTerm.focus();
  });
  await page.keyboard.press('q');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.inputBytes.length), 0);
  await page.evaluate(() => window.keyHook.dispose());
  await page.keyboard.press('q');
  await page.waitForFunction(() => window.inputBytes.length > 0);
  assert.equal(await page.evaluate(() => String.fromCharCode(...window.inputBytes)), 'q');
  const renderObservation = await page.evaluate(async () => {
    const term = window.featureTerm;
    let messages = 0;
    const observe = (event) => {
      if (event.data.type === 'render') messages++;
    };
    term.worker.addEventListener('message', observe);
    await term.write('unobserved');
    await term.flush();
    const defaultMessages = messages;
    const frames = [],
      other = [];
    const first = term.onRender((event) => frames.push(event.frame));
    const second = term.onRender((event) => other.push(event.frame));
    await term.write('observed');
    await term.flush();
    first.dispose();
    const firstCount = frames.length;
    await term.write('second observer');
    await term.flush();
    const firstStopped = firstCount === frames.length;
    second.dispose();
    second.dispose();
    let duplicateCalls = 0;
    const duplicate = () => duplicateCalls++;
    const duplicateA = term.onRender(duplicate),
      duplicateB = term.onRender(duplicate);
    messages = 0;
    await term.write('duplicate observers');
    await term.flush();
    const duplicatesIndependent = duplicateCalls === messages * 2 && messages > 0;
    duplicateA.dispose();
    duplicateCalls = messages = 0;
    await term.write('one duplicate remains');
    await term.flush();
    const duplicateRemains = duplicateCalls === messages && messages > 0;
    duplicateB.dispose();
    messages = 0;
    await term.write('unobserved again');
    await term.flush();
    term.worker.removeEventListener('message', observe);
    return {
      defaultMessages,
      frames,
      other,
      firstStopped,
      duplicatesIndependent,
      duplicateRemains,
      finalMessages: messages,
    };
  });
  assert.equal(renderObservation.defaultMessages, 0);
  assert(renderObservation.frames.length > 0);
  assert(renderObservation.other.length > renderObservation.frames.length);
  assert(
    renderObservation.other.every(
      (frame, i, all) => Number.isInteger(frame) && (!i || frame > all[i - 1]),
    ),
  );
  assert.equal(renderObservation.firstStopped, true);
  assert.equal(renderObservation.duplicatesIndependent, true);
  assert.equal(renderObservation.duplicateRemains, true);
  assert.equal(renderObservation.finalMessages, 0);
  await page.evaluate(async () => {
    window.inputSubscription.dispose();
    await window.featureTerm.dispose();
  });
  assert.deepEqual(errors, []);
  console.log(
    'Native interactions passed: history search, Unicode, reflow, cancellation, word/line/block gestures, keyboard interception and disposal.',
  );
} finally {
  await browser.close();
}
