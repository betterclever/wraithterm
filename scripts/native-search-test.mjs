import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto((process.env.WRAITH_URL ?? 'http://127.0.0.1:5196') + '/playground.html');
  await page.waitForFunction(() => window.wraith);
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:10000;background:black';
    document.body.append(host);
    window.searchTerm = await window.wraith.constructor.mount(host, {
      cols: 120,
      rows: 40,
      scrollback: 300000,
      fit: false,
    });
    await window.searchTerm.write(
      Array.from({ length: 90000 }, (_, n) => `record-${n} ${'build module '.repeat(5)}\r\n`).join(
        '',
      ),
    );
    await window.searchTerm.flush();
    window.searchEvents = [];
    window.searchTerm.onData(() =>
      window.searchEvents.push({ type: 'key', at: performance.now() }),
    );
    window.searchTerm.focus();
    window.pendingSearch = window.searchTerm
      .findNext('missing-long-search-needle')
      .then((result) => {
        window.searchEvents.push({ type: 'search', at: performance.now() });
        return result;
      });
  });
  await page.waitForTimeout(4);
  await page.keyboard.press('x');
  const concurrency = await page.evaluate(async () => {
    // A fence awaits a Rust borrow. Search tasks must join the same queue.
    const flushed = window.searchTerm.flush();
    await Promise.all([window.pendingSearch, flushed]);
    return { events: window.searchEvents, found: await window.pendingSearch };
  });
  assert.deepEqual(concurrency.found, { total: 0, index: -1 });
  const key = concurrency.events.find((e) => e.type === 'key');
  const completed = concurrency.events.find((e) => e.type === 'search');
  assert(
    key && completed && key.at < completed.at,
    'Typing must reach onData before the long scan completes',
  );
  const mutation = await page.evaluate(async () => {
    const term = window.searchTerm;
    // Reuse an existing cached history, then change and reflow it mid-scan.
    const scan = term.findNext('record-12345 ');
    const write = term.write('\r\nUPDATED-needle\r\n');
    const resize = term.resize(73, 30);
    const fence = term.flush();
    await Promise.all([scan, write, resize, fence]);
    const found = await term.findNext('updated-NEEDLE');
    const selected = await term.getText(true);
    const missing = await term.findNext('no-such-needle');
    const cancelled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => term.findNext(`record-${100 + i} `)),
    );
    await term.clearSearch();
    // A reset must invalidate every cached byte and reference.
    await term.write('\x1bcreset-only');
    const old = await term.findNext('record-12345');
    const fresh = await term.findNext('reset-only');
    const pending = term.findNext('reset-only');
    const settled = Promise.allSettled([pending]);
    await term.dispose();
    const disposed = await settled;
    return {
      found,
      selected,
      missing,
      cancelled: cancelled.map((r) => r.status),
      old,
      fresh,
      disposed: disposed.map((r) => r.status),
    };
  });
  assert.equal(mutation.found.total, 1);
  assert.equal(mutation.selected, 'UPDATED-needle');
  assert.deepEqual(mutation.missing, { total: 0, index: -1 });
  assert(mutation.cancelled.slice(0, -1).every((status) => status === 'rejected'));
  assert.equal(mutation.cancelled.at(-1), 'fulfilled');
  assert.equal(mutation.old.total, 0);
  assert.equal(mutation.fresh.total, 1);
  assert.deepEqual(mutation.disposed, ['rejected']);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, concurrency, mutation }, null, 2));
} finally {
  await browser.close();
}
