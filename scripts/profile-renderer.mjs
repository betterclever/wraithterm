import { chromium } from '@playwright/test';
import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const output = resolve(process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/comparison');
const sourceDirectory = resolve(process.env.WRAITH_SOURCE_DIR ?? '.');
const sdkSources = {};
for (const file of (await readdir(resolve(sourceDirectory, 'packages/wraith/src'))).sort()) {
  if ((file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.test.ts'))
    sdkSources[file] = createHash('sha256')
      .update(await readFile(resolve(sourceDirectory, 'packages/wraith/src', file)))
      .digest('hex');
}
const iterations = Number(process.env.WRAITH_PROFILE_ITERATIONS ?? 256);
if (!Number.isInteger(iterations) || iterations < 32 || iterations > 8192)
  throw new Error('WRAITH_PROFILE_ITERATIONS must be an integer between 32 and 8192');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 2600, height: 2100 },
    deviceScaleFactor: 1,
  });
  await page.goto(process.env.WRAITH_URL ?? 'http://127.0.0.1:5173/compare.html?type=wraith');
  await page.waitForFunction(() => window.comparison?.ready);
  await page.evaluate(() => window.comparison.ready);
  await page.evaluate(() => window.comparison.profile(32));
  const adapter = await page.evaluate(() => window.comparison.adapterInfo());
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await page.evaluate((count) => window.comparison.profile(count), iterations);
  const { profile } = await cdp.send('Profiler.stop');
  await writeFile(resolve(output, 'wraith.cpuprofile'), JSON.stringify(profile));
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parents = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id);
  const categories = new Map();
  function category(id) {
    if (categories.has(id)) return categories.get(id);
    let current = id,
      result = 'other sampled work';
    while (nodes.has(current)) {
      const frame = nodes.get(current).callFrame;
      if (frame.url.includes('xterm-renderer') && frame.functionName === 'pack') {
        result = 'packing including callees';
        break;
      }
      if (
        (frame.url.includes('xterm-base') && frame.functionName === 'parse') ||
        (frame.url.includes('xterm-parser') && frame.functionName === 'fastParse')
      ) {
        result = 'parser including callees';
        break;
      }
      if (frame.url.includes('xterm-renderer') && frame.functionName === 'renderRows') {
        result = 'other renderer work';
        break;
      }
      current = parents.get(current);
    }
    categories.set(id, result);
    return result;
  }
  const samples = profile.samples ?? [];
  const times = profile.timeDeltas ?? [];
  const totals = new Map();
  const grouped = new Map();
  for (let i = 0; i < samples.length; i++) {
    const n = nodes.get(samples[i]);
    const name = n.callFrame.functionName || '(anonymous)';
    if (['(idle)', '(program)', '(root)'].includes(name)) continue;
    const key = JSON.stringify({ name, url: n.callFrame.url, line: n.callFrame.lineNumber + 1 });
    totals.set(key, (totals.get(key) ?? 0) + (times[i] ?? 500));
    const group = category(samples[i]);
    grouped.set(group, (grouped.get(group) ?? 0) + (times[i] ?? 500));
  }
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  const hot = [...totals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([k, t]) => ({ ...JSON.parse(k), selfMs: t / 1000, selfPercent: (t / total) * 100 }));
  await writeFile(
    resolve(output, 'profile-summary.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        iterations,
        warmup: 32,
        sourceDirectory,
        head: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: sourceDirectory,
          encoding: 'utf8',
        }).trim(),
        url: page.url(),
        userAgent: await page.evaluate(() => navigator.userAgent),
        sdkSources,
        wasmSha256: createHash('sha256')
          .update(
            await readFile(resolve(sourceDirectory, 'packages/wraith/wasm/wraith_engine_bg.wasm')),
          )
          .digest('hex'),
        adapter,
        samplingIntervalUs: 500,
        measuredSeparatelyFromBenchmark: true,
        activeSampledMs: total / 1000,
        inclusiveGroups: [...grouped].map(([name, us]) => ({
          name,
          sampledMs: us / 1000,
          sampledPercent: (us / total) * 100,
        })),
        hot,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(hot.slice(0, 12), null, 2));
  await page.evaluate(() => window.comparison.dispose());
} finally {
  await browser.close();
}
