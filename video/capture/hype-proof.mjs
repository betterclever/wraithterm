// Public native API, with GPU fences, independently from recording/rendering.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, release } from 'node:os';
const root = resolve(import.meta.dirname, '..'),
  repo = resolve(root, '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const result = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  cpu: cpus()[0].model,
  logicalCpus: cpus().length,
  os: `${process.platform} ${release()}`,
  sources: {},
  runnerSha256: sha(await readFile(new URL(import.meta.url))),
  runs: [],
  methodology:
    'Three serial runs of public native benchmark: 10,000 dense 160x50 frames each, 256 warm frames, GPU fence every 32 frames and at end. Input generation excluded. Parser + snapshot + packing + submission and fences included. This is GPU-completed offscreen throughput, not display FPS or physical presentation. Headline rounds DOWN the slowest run to a 500-frame/s boundary. No capture/fframes render runs concurrently. Other desktop applications remain running; no cross-device claim.',
};
for (const f of [
  'packages/wraith/src/worker.ts',
  'packages/wraith/src/index.ts',
  'packages/wraith/wasm/wraith_engine_bg.wasm',
])
  result.sources[f] = sha(await readFile(resolve(repo, f)));
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({
      viewport: { width: 1920, height: 1200 },
      deviceScaleFactor: 1,
    }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto((process.env.WRAITH_URL ?? 'http://127.0.0.1:5199') + '/playground.html');
  await page.waitForFunction(() => window.wraith);
  await page.evaluate(async () => {
    const C = window.wraith.constructor;
    await window.wraith.dispose();
    document.body.replaceChildren();
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0';
    document.body.append(host);
    window.proof = await C.mount(host, {
      cols: 160,
      rows: 50,
      fit: false,
      fontSize: 14,
      lineHeight: 1.35,
    });
  });
  for (let i = 0; i < 3; i++) {
    const r = await page.evaluate(() =>
      window.proof.benchmark({ frames: 10000, warmup: 256, workload: 'dense' }),
    );
    if (r.frames !== 10000) throw Error('Incomplete GPU work');
    result.runs.push(r);
    console.log(JSON.stringify(r));
  }
  if (errors.length) throw Error(errors.join('; '));
  result.errors = errors;
  result.slowestFencedFramesPerSecond = Math.min(
    ...result.runs.map((r) => r.fencedFramesPerSecond),
  );
  result.headlineValue = Math.floor(result.slowestFencedFramesPerSecond / 500) * 500;
  if (result.headlineValue < 1000) throw Error('Omit unsupported headline: measured below 1000');
  result.headline = result.headlineValue.toLocaleString('en-US') + '+';
  result.label = 'GPU-completed frames/s';
  result.caption = 'Native · 160×50 dense · M5 Max · Chrome 155';
  await page.evaluate(() => window.proof.dispose());
} finally {
  await browser.close();
}
await mkdir(resolve(root, 'claims'), { recursive: true });
await writeFile(resolve(root, 'claims/hype-native.json'), JSON.stringify(result, null, 2) + '\n');
console.log('Headline: ' + result.headline);
