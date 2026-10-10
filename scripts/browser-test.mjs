import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pixelSummary } from './png.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = resolve(process.env.WRAITH_REPORT_DIR ?? resolve(root, 'docs/benchmarks'));
await mkdir(report, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: process.env.WRAITH_HEADFUL !== '1',
  args:
    process.env.WRAITH_SOFTWARE_GPU === '1'
      ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader']
      : [],
});
const errors = [];
const results = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(process.env.WRAITH_URL ?? 'http://127.0.0.1:5173/');
  await page.waitForFunction(
    () => window.wraith || document.getElementById('status')?.classList.contains('error'),
    { timeout: 30000 },
  );
  assert(await page.evaluate(() => !!window.wraith), await page.locator('#status').textContent());
  await page.evaluate(async () => {
    await window.wraith.flush();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const png = await page.locator('#terminal canvas').screenshot();
  const rendered = pixelSummary(png);
  assert(
    rendered.colors > 20 && rendered.bright > 1000,
    `Terminal pixels are empty: ${JSON.stringify(rendered)}`,
  );
  await writeFile(resolve(report, 'terminal.png'), png);
  assert.match(await page.evaluate(() => window.wraith.getText()), /W R A I T H/);
  const box = await page.locator('#terminal canvas').boundingBox();
  const geometry = await page.evaluate(() => ({
    cols: window.wraith.cols,
    rows: window.wraith.rows,
  }));
  await page.mouse.move(
    box.x + (box.width / geometry.cols) * 2.5,
    box.y + (box.height / geometry.rows) * 0.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    box.x + (box.width / geometry.cols) * 12.5,
    box.y + (box.height / geometry.rows) * 0.5,
    { steps: 5 },
  );
  await page.mouse.up();
  assert.equal((await page.evaluate(() => window.wraith.getText(true))).trim(), 'W R A I T H');
  await page.evaluate(() => window.wraith.focus());
  await page.keyboard.type('help');
  await page.keyboard.press('Enter');
  await page.waitForFunction(async () =>
    (await window.wraith.getText()).includes('The architecture'),
  );
  // Rendering can change geometry without losing the Rust/Ghostty instance.
  await page.evaluate(async () => {
    await window.wraith.resize(80, 24);
    await window.wraith.write('\x1b[2J\x1b[Hresize verified');
    await window.wraith.flush();
  });
  assert.match(await page.evaluate(() => window.wraith.getText()), /resize verified/);
  // Check pointer selection, IME text, bracketed paste, and binary transport output.
  await page.evaluate(async () => {
    window.testBytes = [];
    window.testSubscription = window.wraith.onBytes((bytes) => window.testBytes.push(...bytes));
    await window.wraith.write('\x1b[?2004h');
    await window.wraith.paste('paste\ntext\x1b[201~');
  });
  const paste = await page.evaluate(() => String.fromCharCode(...window.testBytes));
  assert(paste.startsWith('\x1b[200~') && paste.endsWith('\x1b[201~'));
  assert(!paste.slice(6, -6).includes('\x1b'));
  await page.evaluate(() => {
    window.testSubscription.dispose();
  });
  // Run each workload at two standard grid sizes, retaining every raw result.
  for (const [cols, rows] of [
    [80, 24],
    [160, 50],
  ]) {
    await page.evaluate(
      async ([c, r]) => {
        await window.wraith.resize(c, r);
      },
      [cols, rows],
    );
    for (const workload of ['sparse', 'dense', 'scroll']) {
      const result = await page.evaluate(
        async (workload) => window.wraith.benchmark({ frames: 512, warmup: 64, workload }),
        workload,
      );
      assert.equal(result.frames, 512);
      assert(result.elapsedMs > 0 && result.fencedFramesPerSecond > 0);
      results.push(result);
      console.log(
        `${cols}x${rows} ${workload}: ${Math.round(result.fencedFramesPerSecond)} GPU-fenced frames/s; CPU p95 ${result.cpuP95Ms.toFixed(3)} ms`,
      );
    }
  }
  const sustained = await page.evaluate(async () =>
    window.wraith.benchmark({ frames: 8192, warmup: 64, workload: 'dense' }),
  );
  assert.equal(sustained.frames, 8192);
  results.push({ ...sustained, sustained: true });
  console.log(
    `160x50 dense sustained: ${Math.round(sustained.fencedFramesPerSecond)} GPU-fenced frames/s over ${(sustained.elapsedMs / 1000).toFixed(2)} seconds`,
  );
  assert.deepEqual(await page.evaluate(() => window.wraithErrors), []);
  // Exercise a real UI benchmark and its export state.
  await page.evaluate(() => window.wraith.fit());
  await page.locator('#clear').click();
  await page.locator('#benchmark').click();
  await page.waitForFunction(
    () => document.getElementById('bench-state')?.textContent === 'Measurement complete',
  );
  await page.screenshot({ path: resolve(report, 'playground.png'), fullPage: true });
  // A second terminal independently initializes, handles backpressure, and frees resources.
  const lifecycle = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'width:400px;height:200px';
    document.body.append(host);
    const second = await window.Wraith.mount(host, {
      cols: 20,
      rows: 3,
      fit: false,
      maxPendingBytes: 8,
      screenReaderMode: true,
    });
    const bytes = new TextEncoder().encode('hello');
    await second.write(bytes);
    await second.flush();
    const text = await second.getText();
    const ownsCopy = bytes.byteLength === 5;
    let backpressure = false;
    try {
      await second.write('123456789');
    } catch (error) {
      backpressure = error.name === 'BackpressureError';
    }
    let ime = '';
    const subscription = second.onData((data) => (ime += data));
    second.input.dispatchEvent(new CompositionEvent('compositionstart'));
    second.input.dispatchEvent(new CompositionEvent('compositionend', { data: '界' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    subscription.dispose();
    const mirror = second.element.querySelector('[role=log]') !== null;
    const pending = second.write('pending').then(
      () => false,
      (error) => error.message.includes('disposed'),
    );
    await second.dispose();
    const cancelled = await pending;
    const removed = host.childElementCount === 0;
    host.remove();
    return { text, ownsCopy, backpressure, ime, mirror, cancelled, removed };
  });
  assert.deepEqual(lifecycle, {
    text: 'hello',
    ownsCopy: true,
    backpressure: true,
    ime: '界',
    mirror: true,
    cancelled: true,
    removed: true,
  });
  await page.evaluate(async () => {
    await window.wraith.dispose();
  });
  assert.equal(await page.locator('.wraith-terminal').count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(report, 'chrome.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        ghostty: JSON.parse(await readFile(resolve(root, 'upstream.json'), 'utf8')).ghostty,
        wasmSha256: createHash('sha256')
          .update(await readFile(resolve(root, 'packages/wraith/wasm/wraith_engine_bg.wasm')))
          .digest('hex'),
        devicePixelRatio: 1,
        fontSizeCssPx: 13,
        lineHeight: 1.45,
        rendered,
        results,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Browser checks passed: actual pixels, keyboard input, resize, paste, six GPU-fenced workloads, UI benchmark, and disposal.',
  );
} finally {
  await browser.close();
}
