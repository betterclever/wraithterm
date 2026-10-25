import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pixelSummary } from './png.mjs';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5196';
const reportDir = process.env.WRAITH_REPORT_DIR ?? '.cache/native-visibility';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
});
const checks = [],
  errors = [];
const report = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sources: {},
  checks,
  errors,
};
for (const f of ['packages/wraith/src/index.ts', 'packages/wraith/src/worker.ts'])
  report.sources[f] = createHash('sha256')
    .update(await readFile(f))
    .digest('hex');
await mkdir(reportDir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const RealObserver = window.IntersectionObserver;
    window.observerRecords = [];
    window.IntersectionObserver = class extends RealObserver {
      constructor(callback, options) {
        const record = { disconnected: false, entries: [] };
        super((entries, observer) => {
          record.entries = entries;
          callback(entries, observer);
        }, options);
        record.deliver = () => callback(record.entries, this);
        window.observerRecords.push(record);
        this.record = record;
      }
      disconnect() {
        this.record.disconnected = true;
        super.disconnect();
      }
    };
  });
  await page.goto(base + '/playground.html');
  await page.waitForFunction(() => window.wraith);
  await page.evaluate(async () => {
    const C = window.wraith.constructor;
    await window.wraith.dispose();
    window.host = document.createElement('div');
    window.host.style.cssText =
      'position:fixed;left:0;top:0;width:1000px;height:600px;z-index:10000';
    document.body.append(window.host);
    window.t = await C.mount(window.host, {
      cols: 80,
      rows: 24,
      fit: false,
      screenReaderMode: true,
    });
    window.frames = 0;
    window.t.onRender(() => window.frames++);
    window.termErrors = [];
    window.t.onError((e) => window.termErrors.push(e.message));
    await window.t.write('\x1b[?25lVISIBLE');
    await window.t.flush();
  });
  const wait = () => page.waitForTimeout(180);
  const setStyle = async (style) => {
    await page.evaluate((s) => Object.assign(window.host.style, s), style);
    await wait();
  };
  const writes = async (label) =>
    page.evaluate(async (label) => {
      const before = window.frames;
      for (let i = 0; i < 12; i++) {
        await window.t.write(`\r\n${label}-${i}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      return { frames: window.frames - before, text: await window.t.getText() };
    }, label);
  await wait();
  assert((await writes('visible')).frames > 0);
  checks.push('visible updates submit');
  for (const [name, style] of [
    ['display-none', { display: 'none' }],
    ['offscreen', { display: 'block', top: '20000px' }],
  ]) {
    await setStyle(style);
    const result = await writes(name);
    assert.equal(result.frames, 0, name);
    assert.match(result.text, new RegExp(name + '-11'));
    await page.evaluate(async (name) => {
      const needle = `${name}-needle`;
      await window.t.resize(79, 23);
      await window.t.write(`\r\n${needle}`);
      const search = await window.t.findNext(needle);
      if (search.total !== 1) throw Error('Hidden search failed');
      if ((await window.t.getText(true)) !== needle) throw Error('Hidden selection failed');
      await window.t.clearSearch();
    }, name);
    const before = await page.evaluate(() => window.frames);
    await page.evaluate(() => window.t.flush());
    assert((await page.evaluate(() => window.frames)) > before, 'hidden explicit flush');
    await wait();
    const clean = await page.evaluate(() => window.frames);
    await setStyle({ display: 'block', top: '0' });
    await page.waitForFunction((n) => window.frames > n, clean);
    assert.equal(
      await page.evaluate(() => window.t.input.getAttribute('aria-label')),
      'Terminal input',
    );
    assert.match(
      await page.evaluate(() => window.t.element.querySelector('.wraith-a11y-screen').textContent),
      /-needle/,
    );
    checks.push(
      `${name}: no ordinary frames; parsing/search/resize/selection/mirror/flush; clean reveal repaints`,
    );
  }
  const png = await page.locator('.wraith-terminal canvas').screenshot();
  const pixels = pixelSummary(png);
  assert(pixels.bright > 100 && pixels.colors > 10);
  await writeFile(reportDir + '/resumed.png', png);
  report.pixels = pixels;
  checks.push('resumed actual canvas pixels');
  // A zero-area intersection can be isIntersecting=true at the viewport edge.
  await setStyle({ left: '1600px' });
  assert.equal((await writes('edge')).frames, 0);
  const edgeFrames = await page.evaluate(() => window.frames);
  await setStyle({ left: '1599px' });
  await page.waitForFunction((n) => window.frames > n, edgeFrames);
  checks.push('zero-area edge pauses; one-pixel partial intersection resumes');
  await setStyle({ left: '0' });
  await page.evaluate(() => {
    const clip = document.createElement('div');
    clip.id = 'clip';
    clip.style.cssText =
      'position:fixed;left:0;top:0;width:1000px;height:1px;overflow:hidden;z-index:10000';
    document.body.append(clip);
    clip.append(window.host);
    Object.assign(window.host.style, { position: 'relative', top: '10px' });
  });
  await wait();
  assert.equal((await writes('clipped')).frames, 0);
  await page.evaluate(() => {
    document.body.append(window.host);
    document.getElementById('clip').remove();
    Object.assign(window.host.style, { position: 'fixed', top: '0' });
  });
  await wait();
  checks.push('overflow-clipped terminal pauses and resumes');
  await setStyle({ display: 'none' });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal((await writes('doc-visible-panel-hidden')).frames, 0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await setStyle({ display: 'block' });
  assert.equal((await writes('doc-hidden-panel-visible')).frames, 0);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await wait();
  assert((await writes('both-visible')).frames > 0);
  checks.push('document and element visibility remain combined');
  await page.evaluate(async () => {
    window.host.style.display = 'none';
    const fence = window.t.flush();
    const writes = Array.from({ length: 20 }, (_, i) => window.t.write(`\r\nfenced-${i}`));
    window.host.style.display = 'block';
    await Promise.all([fence, ...writes, window.t.flush()]);
  });
  checks.push('visibility transitions serialize safely with writes and GPU fences');
  await page.evaluate(async () => {
    await window.t.dispose();
    if (!window.observerRecords.every((r) => r.disconnected)) throw Error('Observer leaked');
    // Simulate an already-queued observer delivery after disconnect/dispose.
    for (const r of window.observerRecords) r.deliver();
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await wait();
  assert.deepEqual(await page.evaluate(() => window.termErrors), []);
  checks.push('observers disconnected; late callbacks after disposal are harmless');
  // Exercise font-loading initialization without sending a pre-init visibility command.
  let heldRoute;
  await page.route('**/held-font.ttf', (route) => {
    heldRoute = route;
  });
  await page.evaluate(() => {
    window.mounting = window.t.constructor.mount(window.host, {
      fit: false,
      font: new URL('/held-font.ttf', location.href),
    });
    window.mounting.catch(() => {});
  });
  while (!heldRoute) await page.waitForTimeout(10);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await heldRoute.fulfill({
    status: 200,
    contentType: 'font/ttf',
    body: await readFile('packages/wraith/wasm/JetBrainsMono-Regular.ttf'),
  });
  await page.evaluate(async () => {
    const t = await window.mounting;
    await t.write('initialization survived');
    await t.flush();
    await t.dispose();
  });
  checks.push('visibility event during deferred font loading does not enter uninitialized worker');
  await page.evaluate(async () => {
    const t = await window.t.constructor.mount(window.host, { fit: false });
    let failed = false;
    t.onError(() => (failed = true));
    t.worker.dispatchEvent(new ErrorEvent('error', { message: 'simulated worker failure' }));
    if (!failed || !window.observerRecords.every((r) => r.disconnected))
      throw Error('Failure observer leaked');
    for (const r of window.observerRecords) r.deliver();
    await t.dispose();
  });
  checks.push('worker failure disconnects visibility observer and ignores late delivery');
  // Observer support is an optimization, not a mounting requirement.
  for (const mode of ['missing', 'throws']) {
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript((mode) => {
      window.IntersectionObserver =
        mode === 'missing'
          ? undefined
          : class {
              constructor() {
                throw Error('Unavailable');
              }
            };
    }, mode);
    await p.goto(base + '/playground.html');
    await p.waitForFunction(() => window.wraith);
    await p.evaluate(async () => {
      const t = window.wraith;
      await t.write('fallback works');
      await t.flush();
      let frames = 0;
      t.onRender(() => frames++);
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await t.write('hidden document');
      await new Promise((r) => setTimeout(r, 100));
      const before = frames;
      await t.write('still hidden');
      await new Promise((r) => setTimeout(r, 100));
      if (frames !== before) throw Error('Document fallback did not pause');
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 100));
      if (frames <= before) throw Error('Document fallback did not resume');
      await t.dispose();
    });
    await p.close();
    checks.push(`document-only fallback: ${mode} observer`);
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(reportDir + '/validation.json', JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
