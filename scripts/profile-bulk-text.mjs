import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const output = process.env.WRAITH_REPORT_DIR ?? '.cache/bulk-text-profiles';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.goto((process.env.WRAITH_URL ?? 'http://127.0.0.1:5196') + '/xterm.html');
  await page.waitForFunction(() => window.compat);
  await page.evaluate(() => {
    window.compat.term.dispose();
    window.profileTerm = new window.compat.Terminal({ cols: 80, rows: 24, scrollback: 1000 });
    window.bulkProfile = () => {
      for (let n = 0; n < 128; n++)
        window.profileTerm._core._inputHandler.parse('abcdefgh01234567'.repeat(65536));
    };
    window.profileTerm._core._inputHandler.parse('abcdefgh01234567'.repeat(65536));
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await page.evaluate(() => window.bulkProfile());
  const { profile } = await cdp.send('Profiler.stop');
  await writeFile(output + '/bulk.cpuprofile', JSON.stringify(profile));
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const totals = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const frame = nodes.get(profile.samples[i]).callFrame;
    if (['(idle)', '(program)', '(root)'].includes(frame.functionName)) continue;
    const name = frame.functionName || '(anonymous)';
    totals.set(name, (totals.get(name) ?? 0) + profile.timeDeltas[i]);
  }
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  const hot = [...totals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, us]) => ({ name, selfMs: us / 1000, selfPercent: (us / total) * 100 }));
  const result = {
    date: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceSha256: createHash('sha256')
      .update(await readFile('packages/wraith/src/xterm-print.ts'))
      .digest('hex'),
    userAgent: await page.evaluate(() => navigator.userAgent),
    samplingIntervalUs: 500,
    methodology:
      '128 synchronous 1MiB ASCII parse calls; no open renderer; separate from timing. Sampling percentages are diagnostic, not wall-clock improvement claims.',
    hot,
  };
  await writeFile(output + '/profile-summary.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(hot.slice(0, 8), null, 2));
} finally {
  await browser.close();
}
