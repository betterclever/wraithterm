// Keystroke round trip through serve: input → PTY (tty echo) → output parsed in the page.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright');
const serve = spawn(
  'node',
  [
    process.env.SERVE_BIN ??
      (process.env.SERVE_REPO ?? new URL('../..', import.meta.url).pathname) +
        '/packages/wraith/bin/wraithterm.mjs',
    'serve',
    '--port',
    process.env.PORT ?? '7793',
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
const samples = Number(process.env.SAMPLES ?? 30);
const ms = await page.evaluate(async (samples) => {
  const out = [],
    t = window.wraith;
  for (let i = 0; i < samples; i++) {
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
}, samples);
const at = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))].toFixed(1);
console.log('echo p50', at(0.5), 'p90', at(0.9), 'max', at(1));
if (process.env.RAW) console.log(JSON.stringify(ms.map((x) => +x.toFixed(2))));
await browser.close();
serve.kill();
