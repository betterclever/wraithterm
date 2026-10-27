// Engine-only throughput: workload files written straight into Wraith.mount()
// (no PTY, no WebSocket), timed from the first write to flush(). Several builds
// are compared in one browser session, interleaved and rotated per round, so
// shared-machine load affects each build alike.
//
//   VARIANTS=base=.cache/ab/base,simd=.cache/ab/simd \
//   FILES=/path/logs.ansi,/path/ascii.txt ROUNDS=4 \
//   WRAITH_URL=http://127.0.0.1:5223 node scripts/engine-throughput.mjs out.json
//
// Each variant directory holds a copy of packages/wraith/{dist,wasm} under the
// served root (Vite's fs.allow covers the repository). The visible screen text is
// hashed after each run so builds can be checked for identical output.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { resolve } from 'node:path';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5223';
const rounds = Number(process.env.ROUNDS ?? 3);
const cols = Number(process.env.COLS ?? 160),
  rows = Number(process.env.ROWS ?? 50);
const warm = process.env.WARM === '1';
const files = (process.env.FILES ?? '').split(',').filter(Boolean);
const variants = (process.env.VARIANTS ?? 'current=packages/wraith')
  .split(',')
  .map((v) => v.split('='))
  .map(([name, dir]) => ({ name, dir: resolve(dir) }));
if (!files.length) throw new Error('Set FILES to a comma-separated list of workload files');
const out = process.argv[2];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const load = () => execFileSync('/usr/sbin/sysctl', ['-n', 'vm.loadavg']).toString().trim();
const report = {
  date: new Date().toISOString(),
  cpu: cpus()[0].model,
  logicalCpus: cpus().length,
  os: `${process.platform} ${release()}`,
  grid: `${cols}x${rows}`,
  warm,
  chromeArgs: process.env.CHROME_ARGS ?? '',
  method:
    'Wraith.mount() at the given grid, DPR 2, headed Chrome; each file is written with term.write() in 64 KiB chunks (awaiting every 64th write), then flush(). Time covers parse and coalesced rendering; no PTY or WebSocket. Variants alternate order per round in one browser.',
  variants: variants.map((v) => ({
    ...v,
    wasmBytes: statSync(`${v.dir}/wasm/wraith_engine_bg.wasm`).size,
    wasmSha256: sha(readFileSync(`${v.dir}/wasm/wraith_engine_bg.wasm`)),
  })),
  files: files.map((f) => ({ file: f.split('/').pop(), bytes: statSync(f).size })),
  runs: [],
};
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: process.env.HEADLESS === '1',
  args: [
    '--window-position=0,0',
    '--enable-unsafe-webgpu',
    ...(process.env.CHROME_ARGS ?? '').split(' ').filter(Boolean),
  ],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1374, height: 980 },
    deviceScaleFactor: 2,
  });
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.route('**/__workload/**', (route) =>
    route.fulfill({
      body: readFileSync(decodeURIComponent(new URL(route.request().url()).pathname.slice(11))),
    }),
  );
  await page.route('**/__engine-bench.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }),
  );
  await page.goto(`${base}/__engine-bench.html`);
  report.userAgent = await page.evaluate(() => navigator.userAgent);
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? [...variants].reverse() : variants;
    for (const file of files)
      for (const variant of order) {
        const loadBefore = load();
        const result = await page.evaluate(
          async ({ url, file, cols, rows, warm }) => {
            const { Wraith } = await import(url);
            document.body.innerHTML = '<div id=t style="position:fixed;inset:6px"></div>';
            const mountStart = performance.now();
            const term = await Wraith.mount(document.getElementById('t'), {
              cols,
              rows,
              fit: false,
              fontSize: 14,
            });
            const mountMs = performance.now() - mountStart;
            const bytes = new Uint8Array(
              await (await fetch('/__workload/' + encodeURIComponent(file))).arrayBuffer(),
            );
            if (warm) {
              // Optional warm pass: the same bytes once, then a full reset, so
              // the timed pass runs on tiered-up (optimized) Wasm code.
              for (let i = 0; i < bytes.length; i += 65536)
                await term.write(bytes.subarray(i, i + 65536));
              await term.write('\x1bc');
              await term.flush();
            }
            await new Promise((r) => setTimeout(r, 500));
            const start = performance.now();
            let last;
            for (let i = 0; i < bytes.length; i += 65536) {
              last = term.write(bytes.subarray(i, i + 65536));
              if ((i / 65536) % 64 === 63) await last;
            }
            await last;
            await term.flush();
            const seconds = (performance.now() - start) / 1000;
            const text = await term.getText();
            const digest = Array.from(
              new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
              (b) => b.toString(16).padStart(2, '0'),
            ).join('');
            await term.dispose();
            return {
              bytes: bytes.length,
              seconds,
              MBps: bytes.length / seconds / 1e6,
              mountMs,
              digest,
            };
          },
          { url: `/@fs${variant.dir}/dist/index.js`, file, cols, rows, warm },
        );
        const run = {
          variant: variant.name,
          file: file.split('/').pop(),
          round,
          loadBefore,
          loadAfter: load(),
          ...result,
        };
        report.runs.push(run);
        console.log(
          `${run.file.padEnd(18)} r${round} ${variant.name.padEnd(10)} ${run.MBps.toFixed(1).padStart(7)} MB/s  mount ${run.mountMs.toFixed(0).padStart(4)} ms  ${run.digest.slice(0, 12)}  load ${loadBefore}`,
        );
        if (out) writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
      }
  }
} finally {
  await browser.close();
}
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
report.summary = [];
for (const f of report.files)
  for (const v of variants) {
    const r = report.runs
      .filter((x) => x.file === f.file && x.variant === v.name)
      .map((x) => x.MBps);
    report.summary.push({
      file: f.file,
      variant: v.name,
      medianMBps: +median(r).toFixed(1),
      medianMountMs: +median(
        report.runs.filter((x) => x.file === f.file && x.variant === v.name).map((x) => x.mountMs),
      ).toFixed(1),
      minMBps: +Math.min(...r).toFixed(1),
      maxMBps: +Math.max(...r).toFixed(1),
      digests: [
        ...new Set(
          report.runs.filter((x) => x.file === f.file && x.variant === v.name).map((x) => x.digest),
        ),
      ],
    });
  }
console.table(
  report.summary.map(({ digests, ...s }) => ({
    ...s,
    digest: digests.map((d) => d.slice(0, 8)).join(' '),
  })),
);
if (out) writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
