import { chromium } from '@playwright/test';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu'],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});
await page.goto('http://127.0.0.1:5199/');
await page.waitForTimeout(4000);
await page.screenshot({ path: '.cache/scene/site.png', fullPage: true }); // input for the preview pane
await browser.close();
