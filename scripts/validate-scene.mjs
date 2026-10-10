import { chromium } from '@playwright/test';
import { pixels, pixelSummary } from './png.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const out = resolve('docs/benchmarks/comparison');
await mkdir(out, { recursive: true });
const results = [];
try {
  for (const dpr of [1, 2])
    for (const workload of ['complex', 'churn', 'scroll']) {
      if (dpr === 2 && workload === 'scroll') continue;
      let expected;
      for (const type of ['dom', 'webgl', 'wraith', 'ghostty']) {
        const page = await browser.newPage({
          viewport: { width: 2600, height: 2100 },
          deviceScaleFactor: dpr,
        });
        await page.goto(`http://127.0.0.1:5173/compare.html?type=${type}&workload=${workload}`);
        await page.waitForFunction(() => window.comparison?.ready);
        assert(await page.evaluate(() => window.comparison.ready));
        await page.evaluate(() => window.comparison.profile(32));
        const text = await page.evaluate(() => window.comparison.text());
        const hash = createHash('sha256').update(text).digest('hex');
        expected ??= hash;
        assert.equal(hash, expected, `${type} final text mismatch`);
        const png = await page.locator('#scene').screenshot();
        const p = pixels(png);
        let badRed = 0;
        for (let i = 0; i < p.data.length; i += p.bpp)
          if (p.data[i] >= 240 && p.data[i + 1] < 12 && p.data[i + 2] < 12) badRed++;
        const result = {
          type,
          workload,
          dpr,
          finalTextSha256: hash,
          unexpectedRedPixels: badRed,
          pixels: pixelSummary(png),
          valid: badRed < 10,
        };
        results.push(result);
        console.log(JSON.stringify(result));
        await writeFile(resolve(out, `${workload}-${type}-dpr${dpr}-warm.png`), png);
        await writeFile(
          resolve(out, 'visual-validation.json'),
          JSON.stringify(results, null, 2) + '\n',
        );
        await page.evaluate(() => window.comparison.dispose());
        await page.close();
      }
    }
} finally {
  await browser.close();
}
