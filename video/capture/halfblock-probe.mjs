// Quick probe: real-time half-block playback rate per renderer and grid. Not a claim record.
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
const repo = '/Users/betterclever/projects/wraith';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5199';
const module = '/@fs' + resolve(repo, 'video/capture/halfblock.js');
const grids = (process.env.GRIDS ?? '240x80').split(',');
const counts = (process.env.COUNTS ?? '1').split(',').map(Number);
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: process.env.HEADED ? false : true,
  args: ['--enable-unsafe-webgpu'],
});
for (const grid of grids)
  for (const n of counts) {
    const [cols, rows] = grid.split('x').map(Number);
    for (const type of (process.env.TYPES ?? 'webgl,wraith,webgl,wraith').split(',')) {
      const page = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: Number(process.env.DPR ?? 1),
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/compare.html');
      await page.evaluate(
        async ([m, t, c, r, n, sc]) => (await import(m)).run(t, c, r, 90, n, sc),
        [module, type, cols, rows, n, process.env.SCENE ?? 'tunnel'],
      );
      await page.waitForTimeout(2000);
      const a = await page.evaluate(() => window.rate());
      await page.evaluate(() => window.reset());
      await page.waitForTimeout(5000);
      const info = await page.evaluate(() => ({
        rate: window.rate(),
        min: window.minRate(),
        grid: window.grid,
        renderer: window.renderer,
        bytes: window.frameBytes,
      }));
      console.log(
        JSON.stringify({
          type,
          ...info,
          warm2s: +a.toFixed(1),
          min: +info.min.toFixed(1),
          rate: +info.rate.toFixed(1),
          renderer: Array.isArray(info.renderer)
            ? [...new Set(info.renderer.map(String))].join('/')
            : info.renderer,
          errors,
        }),
      );
      await page.close();
    }
  }
await browser.close();
