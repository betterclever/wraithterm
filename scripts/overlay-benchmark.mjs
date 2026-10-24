import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import assert from 'node:assert/strict';
const output = process.env.WRAITH_REPORT_DIR ?? '.cache/gold-overlay-benchmark';
const baseline = process.env.WRAITH_BASELINE_DIR ?? '.cache/gold-baseline';
await mkdir(output, { recursive: true });
async function measure(a, kind) {
  const t = a.terminal;
  const decorations = [];
  if (kind === 'decorated')
    for (let y = 0; y < 80; y += 4) {
      const marker = t.registerMarker(y - t.buffer.active.cursorY);
      if (!marker) throw new Error('Missing benchmark marker');
      decorations.push(
        marker,
        t.registerDecoration({ marker, x: 10, width: 20, backgroundColor: '#774411' }),
      );
    }
  if (kind === 'hover')
    t._core.linkifier._onShowLinkUnderline.fire({ x1: 10, y1: 3, x2: 30, y2: 3, cols: 240 });
  for (let i = 0; i < 64; i++) {
    a.parse(a.inputs[i % 8].bytes);
    a.draw();
    if (i % 32 === 31) await a.finish();
  }
  await a.finish();
  const renderer = t.renderer,
    before = a.submitted(),
    times = [],
    start = performance.now();
  for (let i = 0; i < 256; i++) {
    const tick = performance.now();
    a.parse(a.inputs[i % 8].bytes);
    a.draw();
    times.push(performance.now() - tick);
    if (i % 32 === 31) await a.finish();
  }
  await a.finish();
  const elapsedMs = performance.now() - start,
    submitted = a.submitted() - before;
  if (renderer === 'webgpu' && submitted !== 256) throw new Error('Dropped GPU submission');
  const text = a.text();
  for (const d of decorations) d.dispose();
  times.sort((a, b) => a - b);
  return {
    renderer,
    reason: t.rendererFallbackReason,
    frames: 256,
    submitted,
    elapsedMs,
    updatesPerSecond: 256000 / elapsedMs,
    cpuP50: times[128],
    cpuP95: times[243],
    text,
  };
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fingerprint = async (root) =>
  Object.fromEntries(
    await Promise.all(
      ['xterm-renderer.ts', 'xterm-input.ts', 'xterm-print.ts', 'xterm-parser.js'].map(
        async (f) => [f, await readFile(root + '/packages/wraith/src/' + f).then(sha, () => null)],
      ),
    ),
  );
const beforeSources = await fingerprint(baseline),
  afterSources = await fingerprint('.');
const result = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  before: JSON.parse(await readFile(baseline + '/baseline.json')).head,
  beforeSources,
  afterSources,
  cpu: cpus()[0].model,
  method:
    '240x80 dense precomputed ANSI, DPR1, 64 warmup + 256 measured updates. Forced DOM layout; GPU completion every 32. Three alternating before/after rounds. DOM results are synchronous updates, not GPU throughput.',
  results: [],
};
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  for (const kind of ['plain', 'decorated', 'hover'])
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const build of repeat % 2 ? ['after', 'before'] : ['before', 'after']) {
        const page = await browser.newPage({
          viewport: { width: 2600, height: 2100 },
          deviceScaleFactor: 1,
        });
        await page.route('**/compare.js*', async (route) => {
          const response = await route.fetch();
          let body = await response.text();
          assert(body.includes('window.comparison = {'));
          body =
            `const measureOverlay=${measure.toString()};\n` +
            body.replace(
              'window.comparison = {',
              'window.comparison = { measureOverlay:kind=>measureOverlay(active,kind),',
            );
          await route.fulfill({ response, body });
        });
        await page.goto(
          `http://127.0.0.1:${build === 'before' ? 5190 : 5173}/compare.html?type=wraith&workload=complex`,
        );
        await page.waitForFunction(() => window.comparison?.ready);
        assert(await page.evaluate(() => window.comparison.ready));
        result.userAgent ??= await page.evaluate(() => navigator.userAgent);
        result.adapter ??= await page.evaluate(() => window.comparison.adapterInfo());
        const { text, ...run } = await page.evaluate(
          (kind) => window.comparison.measureOverlay(kind),
          kind,
        );
        assert.equal(run.renderer, build === 'before' && kind !== 'plain' ? 'dom' : 'webgpu');
        result.results.push({ kind, repeat, build, ...run, textSha256: sha(text) });
        console.log(kind, build, Math.round(run.updatesPerSecond), run.renderer);
        await page.evaluate(() => window.comparison.dispose());
        await page.close();
      }
    }
} finally {
  await browser.close();
}
assert.deepEqual(await fingerprint(baseline), beforeSources);
assert.deepEqual(await fingerprint('.'), afterSources);
assert.equal(new Set(result.results.map((r) => r.textSha256)).size, 1);
await writeFile(output + '/runs.json', JSON.stringify(result, null, 2) + '\n');
