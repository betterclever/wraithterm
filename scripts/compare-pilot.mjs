import { chromium } from '@playwright/test';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  for (const type of ['dom', 'webgl', 'wraith', 'ghostty']) {
    const page = await browser.newPage({ viewport: { width: 2600, height: 2100 } });
    page.on('pageerror', (e) => console.log('ERROR', e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('CONSOLE', m.text());
    });
    await page.goto(`http://127.0.0.1:5173/compare.html?type=${type}`);
    await page.waitForFunction(() => window.comparison?.ready);
    const meta = await page.evaluate(() => window.comparison.ready);
    console.log(
      type,
      meta
        ? { dims: meta.dimensions, bytes: meta.bytesPerFrame }
        : await page.evaluate(() => window.failure),
    );
    if (meta) {
      const result = await page.evaluate(
        (type) =>
          window.comparison.run({ type, workload: 'complex', cols: 240, rows: 80, frames: 32 }),
        type,
      );
      console.log(type, JSON.stringify(result));
      await page.locator('#scene').screenshot({ path: `../../work/pilot-${type}.png` });
    }
    await page.close();
  }
} finally {
  await browser.close();
}
