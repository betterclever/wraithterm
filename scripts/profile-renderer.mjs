import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const output = resolve('docs/benchmarks/comparison');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 2600, height: 2100 } });
  await page.goto('http://127.0.0.1:5173/compare.html?type=wraith');
  await page.waitForFunction(() => window.comparison?.ready);
  await page.evaluate(() => window.comparison.ready);
  await page.evaluate(() => window.comparison.profile(32));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await page.evaluate(() => window.comparison.profile(256));
  const { profile } = await cdp.send('Profiler.stop');
  await writeFile(resolve(output, 'wraith.cpuprofile'), JSON.stringify(profile));
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const samples = profile.samples ?? [];
  const times = profile.timeDeltas ?? [];
  const totals = new Map();
  for (let i = 0; i < samples.length; i++) {
    const n = nodes.get(samples[i]);
    const name = n.callFrame.functionName || '(anonymous)';
    if (['(idle)', '(program)', '(root)'].includes(name)) continue;
    const key = JSON.stringify({ name, url: n.callFrame.url, line: n.callFrame.lineNumber + 1 });
    totals.set(key, (totals.get(key) ?? 0) + (times[i] ?? 500));
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
        samplingIntervalUs: 500,
        measuredSeparatelyFromBenchmark: true,
        activeSampledMs: total / 1000,
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
