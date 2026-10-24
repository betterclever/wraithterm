// Untimed upload accounting: instrument only this separate run, never the speed benchmark.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = process.cwd();
const baseline = resolve(process.env.WRAITH_BASELINE_DIR ?? '.cache/retained-rows-baseline');
const output = resolve(process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/retained-rows');
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const results = [];
try {
  for (const type of ['wraith', 'ghostty'])
    for (const [version, directory, url] of [
      ['before', baseline, process.env.WRAITH_BEFORE_URL ?? 'http://127.0.0.1:5190'],
      ['after', root, process.env.WRAITH_URL ?? 'http://127.0.0.1:5173'],
    ]) {
      const page = await browser.newPage({ viewport: { width: 2600, height: 2100 } });
      await page.goto(`${url}/compare.html?type=${type}&workload=append`);
      await page.waitForFunction(() => window.comparison?.ready);
      assert(await page.evaluate(() => window.comparison.ready));
      await page.evaluate(() => window.comparison.profile(32));
      const result = await page.evaluate(
        async ({ type }) => {
          const loaded = performance
            .getEntriesByType('resource')
            .find((entry) => entry.name.includes('/packages/wraith/wasm/wraith_engine.js'));
          if (!loaded) throw new Error('Could not identify the loaded engine module');
          const { Compositor, Engine } = await import(loaded.name);
          const prototype = type === 'ghostty' ? Engine.prototype : Compositor.prototype;
          const method =
            type === 'ghostty'
              ? 'render'
              : typeof prototype.render_retained === 'function'
                ? 'render_retained'
                : 'render_staged';
          const original = prototype[method];
          let frames = 0,
            cells = 0,
            rowMap = 0,
            total = 0;
          prototype[method] = function (...args) {
            const before = type === 'ghostty' ? this.metrics()[4] : 0;
            const oldCells = Number(this.cell_upload_bytes ?? 0n),
              oldMap = Number(this.row_map_upload_bytes ?? 0n);
            const result = original.apply(this, args);
            if (!result) throw new Error('Upload probe did not submit its frame');
            frames++;
            if (type === 'ghostty') total += this.metrics()[4] - before;
            else if (method === 'render_staged') cells += args[0] * 20;
            if (typeof this.cell_upload_bytes === 'bigint')
              cells += Number(this.cell_upload_bytes) - oldCells;
            if (typeof this.row_map_upload_bytes === 'bigint')
              rowMap += Number(this.row_map_upload_bytes) - oldMap;
            return result;
          };
          try {
            await window.comparison.profile(512);
          } finally {
            prototype[method] = original;
          }
          return { frames, cells, rowMap, total };
        },
        { type },
      );
      assert.equal(result.frames, 512, 'Instrumented method must observe all frames');
      const bytes =
        type === 'ghostty' && version === 'before' ? result.total : result.cells + result.rowMap;
      results.push({
        type,
        version,
        wasmSha256: createHash('sha256')
          .update(await readFile(resolve(directory, 'packages/wraith/wasm/wraith_engine_bg.wasm')))
          .digest('hex'),
        ...result,
        uploadBytesPerUpdate: bytes / result.frames,
      });
      await page.evaluate(() => window.comparison.dispose());
      await page.close();
    }
} finally {
  await browser.close();
}
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, 'uploads.json'),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      workload: 'append',
      frames: 512,
      warmup: 32,
      grid: { cols: 240, rows: 80 },
      measuredSeparatelyFromSpeed: true,
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(results, null, 2));
