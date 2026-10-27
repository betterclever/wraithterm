// Keystroke round trip through serve: input → PTY (tty echo) → output parsed in the page.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright');
const serve = spawn(
  'node',
  [
    (process.env.SERVE_REPO ?? new URL('../..', import.meta.url).pathname) +
      '/packages/wraith/bin/wraithterm.mjs',
    'serve',
    '--port',
    '7793',
    '--no-install',
    '--',
    '/bin/cat',
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
let text = '';
const link = await new Promise((done) =>
  serve.stdout.on('data', (d) => {
    text += d;
    const m = text.match(/http:\/\/\S+token=\S+/);
    if (m) done(m[0]);
  }),
);
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu'],
});
const page = await browser.newPage();
await page.goto(link);
await new Promise((r) => setTimeout(r, 2000));
const ms = await page.evaluate(async () => {
  const out = [],
    t = window.wraith;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const start = performance.now();
    const done = new Promise((r) => {
      const d = t.onRender(async () => {
        if ((await t.getText()).includes('k' + i + 'z')) {
          d.dispose();
          r();
        }
      });
    });
    await t.paste('k' + i + 'z');
    await done;
    out.push(performance.now() - start);
  }
  return out.sort((a, b) => a - b);
});
console.log('echo p50', ms[15].toFixed(1), 'p90', ms[27].toFixed(1), 'max', ms[29].toFixed(1));
await browser.close();
serve.kill();
