// Mount latency and time to first content for fresh Wraith.mount() terminals:
// after `delay` ms, one coloured prompt line is written and timed to flush().
// Variants alternate per repetition in one browser, as in engine-throughput.mjs.
//
//   VARIANTS=base=.cache/ab/base,new=.cache/ab/new DELAYS=0,30,100 REPS=8 \
//   WRAITH_URL=http://127.0.0.1:5223 node scripts/engine-first-content.mjs out.json
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5223';
const reps = Number(process.env.REPS ?? 8);
const delays = (process.env.DELAYS ?? '0,30,100').split(',').map(Number);
const variants = (process.env.VARIANTS ?? 'current=packages/wraith')
  .split(',')
  .map((v) => v.split('='))
  .map(([name, dir]) => ({ name, dir: resolve(dir) }));
const load = () => execFileSync('/usr/sbin/sysctl', ['-n', 'vm.loadavg']).toString().trim();
const report = {
  date: new Date().toISOString(),
  method:
    'Fresh Wraith.mount() (160x50, DPR 2, headed Chrome) per sample; mountMs is mount() to resolve. After `delay` ms, a 90-byte coloured prompt line is written and firstContentMs runs from write() to flush() resolving. Variants alternate order per repetition.',
  variants,
  runs: [],
};
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: process.env.HEADLESS === '1',
  args: ['--window-position=0,0', '--enable-unsafe-webgpu'],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1374, height: 980 },
    deviceScaleFactor: 2,
  });
  await page.route('**/__engine-bench.html', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }),
  );
  await page.goto(`${base}/__engine-bench.html`);
  for (const delay of delays)
    for (let rep = 0; rep < reps; rep++)
      for (const variant of rep % 2 ? [...variants].reverse() : variants) {
        const [mountMs, firstContentMs] = await page.evaluate(
          async ({ url, delay }) => {
            const { Wraith } = await import(url);
            document.body.innerHTML = '<div id=t style="position:fixed;inset:6px"></div>';
            const start = performance.now();
            const term = await Wraith.mount(document.getElementById('t'), {
              cols: 160,
              rows: 50,
              fit: false,
              fontSize: 14,
            });
            const mounted = performance.now() - start;
            if (delay) await new Promise((r) => setTimeout(r, delay));
            const write = performance.now();
            await term.write(
              '\x1b[1;32muser@host\x1b[0m:\x1b[1;34m~/projects/wraith\x1b[0m$ ls -la && echo done\r\n',
            );
            await term.flush();
            const first = performance.now() - write;
            await new Promise((r) => setTimeout(r, 300));
            await term.dispose();
            return [mounted, first];
          },
          { url: `/@fs${variant.dir}/dist/index.js`, delay },
        );
        report.runs.push({
          variant: variant.name,
          delay,
          rep,
          load: load(),
          mountMs,
          firstContentMs,
        });
        console.log(
          `delay ${String(delay).padStart(3)} ${variant.name.padEnd(8)} mount ${mountMs.toFixed(1).padStart(5)} ms  first content ${firstContentMs.toFixed(1).padStart(5)} ms`,
        );
      }
} finally {
  await browser.close();
}
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
report.summary = [];
for (const delay of delays)
  for (const v of variants) {
    const r = report.runs.filter((x) => x.delay === delay && x.variant === v.name);
    const first = r.map((x) => x.firstContentMs);
    report.summary.push({
      delay,
      variant: v.name,
      medianMountMs: +median(r.map((x) => x.mountMs)).toFixed(1),
      medianFirstContentMs: +median(first).toFixed(1),
      minFirstContentMs: +Math.min(...first).toFixed(1),
      maxFirstContentMs: +Math.max(...first).toFixed(1),
    });
  }
console.table(report.summary);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 1) + '\n');
