// A branded browser shell texture; product pixels are captured independently.
import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const font = (await readFile(resolve(root, 'media/JetBrainsMono-Regular.ttf'))).toString('base64');
await mkdir(resolve(root, 'footage'), { recursive: true });
const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const p = await b.newPage({ viewport: { width: 1920, height: 150 }, deviceScaleFactor: 1 });
  await p.setContent(
    `<style>@font-face{font-family:Mono;src:url(data:font/ttf;base64,${font})}*{box-sizing:border-box}body{margin:0;background:#100c09;color:#bca58f;height:150px;display:flex;align-items:center;font:27px Mono}.dots{width:220px;display:flex;gap:15px;padding-left:45px}.dots i{width:18px;height:18px;background:#c28a55;border-radius:50%;display:block}.address{height:64px;width:1200px;background:#1a130e;border:1px solid #342417;border-radius:14px;display:flex;align-items:center;justify-content:center;letter-spacing:1px}.lock{display:inline-block;width:15px;height:17px;border:2px solid #917657;border-radius:3px;margin-right:22px}.tail{margin-left:auto;padding-right:50px;opacity:.6;font-size:36px}</style><div class=dots><i></i><i></i><i></i></div><div class=address><span class=lock></span>wraithterm.com</div><div class=tail>+</div>`,
  );
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: resolve(root, 'footage/hype-chrome.png') });
} finally {
  await b.close();
}
