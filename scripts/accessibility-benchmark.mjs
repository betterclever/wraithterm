// Screen reader mode overhead: parse+render throughput and GPU-fenced frames for
// a baseline build (screen reader off) against this build (off and on).
// Both builds are served by one Vite server through /@fs, in one browser.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { resolve } from 'node:path';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const output = process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/accessibility';
const repeats = Number(process.env.WRAITH_REPETITIONS ?? 5);
const beforeRoot = process.env.WRAITH_BEFORE_ROOT; // a package root with a compiled dist/
const beforeHash = process.env.WRAITH_BEFORE_HASH;
const headless = process.env.HEADED !== '1';
assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 20);
const sha = async (p) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex');
const root = process.cwd();
const harness = resolve(root, '.cache/a11y-bench/index.html');
await mkdir(resolve(root, '.cache/a11y-bench'), { recursive: true });
await writeFile(
  harness,
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>bench</title></head>' +
    '<body style="margin:0;background:#000"></body></html>\n',
);
const builds = [
  {
    name: 'branch',
    module: `/@fs${resolve(root, 'packages/wraith/dist/index.js')}`,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty:
      execFileSync('git', ['status', '--porcelain', 'packages/wraith/src'], {
        encoding: 'utf8',
      }).trim().length > 0,
    sources: {
      'index.js': await sha('packages/wraith/dist/index.js'),
      'worker.js': await sha('packages/wraith/dist/worker.js'),
      wasm: await sha('packages/wraith/wasm/wraith_engine_bg.wasm'),
    },
  },
];
if (beforeRoot) {
  assert(beforeHash, 'WRAITH_BEFORE_HASH names the baseline commit');
  builds.unshift({
    name: 'baseline',
    module: `/@fs${resolve(beforeRoot, 'dist/index.js')}`,
    head: beforeHash,
    sources: {
      'index.js': await sha(resolve(beforeRoot, 'dist/index.js')),
      'worker.js': await sha(resolve(beforeRoot, 'dist/worker.js')),
      wasm: await sha(resolve(beforeRoot, 'wasm/wraith_engine_bg.wasm')),
    },
  });
}
const configs = builds.flatMap((b) =>
  b.name === 'baseline'
    ? [{ build: b, sr: false }]
    : [
        { build: b, sr: false },
        { build: b, sr: true },
      ],
);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless,
});
const report = {
  date: new Date().toISOString(),
  hardware: {
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    os: `${process.platform} ${release()}`,
  },
  chrome: browser.version(),
  headless,
  builds: builds.map(({ module, ...b }) => b),
  runnerSha256: await sha('scripts/accessibility-benchmark.mjs'),
  methodology:
    'One Chrome, one Vite dev server; both builds load as ES modules into one page per repetition. Each configuration mounts its own visible 160x50 terminal (fit off, 10,000 lines scrollback, 1500x1000 host, stacked without overlap). Every round runs each configuration once in rotated order: (1) bulk: 32 MiB of SGR-colored log lines in 64 KiB chunks, each write awaited (parsed), then flush() (forced render + GPU fence), MiB/s; (2) GPU-fenced benchmark() dense and scroll, 512 frames each. Paired ratios divide each configuration by the reference measured in the same round. After the rounds, (3) stream: 2 s of 40 lines every 16 ms per configuration, counting render submissions (onRender), which are submissions, not display presentation. Screen reader on uses announcements "always", so worker sampling, diffing, mirror DOM and live-region updates all run.',
  runs: [],
};
const rounds = Number(process.env.WRAITH_ROUNDS ?? 6);
/** One page holds all configurations; every round runs each once, in rotated
 * order, so machine load drifts affect them alike (paired comparison). */
async function measure(repetition) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 3200 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/@fs${harness}`);
    return await page
      .evaluate(
        async ({ configs, rounds, repetition }) => {
          const encoder = new TextEncoder();
          let line = 0;
          const logLine = () =>
            `\x1b[38;5;${16 + (line % 216)}m${String(line++).padStart(8, '0')}\x1b[0m ` +
            `\x1b[1mINFO\x1b[0m request ${'abcdefghij'.repeat(10)}`.slice(0, 110) +
            '\r\n';
          let chunk = '';
          while (chunk.length < 65536) chunk += logLine();
          const bytes = encoder.encode(chunk);
          const total = 32 * 1024 * 1024;
          const terms = [];
          for (const [i, config] of configs.entries()) {
            const { Wraith } = await import(config.module);
            const host = document.createElement('div');
            host.style.cssText = `position:absolute;left:0;top:${i * 1050}px;width:1500px;height:1000px`;
            document.body.append(host);
            const t = await Wraith.mount(host, {
              cols: 160,
              rows: 50,
              fit: false,
              scrollback: 10000,
              screenReaderMode: config.sr,
              accessibility: { announcements: 'always' },
            });
            const state = { t, host, config, frames: 0, announcements: 0 };
            t.onRender(() => state.frames++);
            t.onAnnounce?.(() => state.announcements++);
            await t.write('warmup\r\n'.repeat(100));
            await t.flush();
            terms.push(state);
          }
          const rows = [];
          for (let round = 0; round < rounds; round++) {
            const order = terms.map((_, i) => terms[(i + round + repetition) % terms.length]);
            const result = Object.fromEntries(terms.map((s) => [s.config.key, {}]));
            for (const s of order) {
              const start = performance.now();
              for (let sent = 0; sent < total; sent += bytes.byteLength) await s.t.write(bytes);
              await s.t.flush();
              result[s.config.key].bulkMiBPerSecond =
                total / 1048576 / ((performance.now() - start) / 1000);
            }
            for (const s of order) {
              const dense = await s.t.benchmark({ workload: 'dense', frames: 512 });
              result[s.config.key].denseFencedFps = dense.fencedFramesPerSecond;
              result[s.config.key].adapter = dense.adapter;
            }
            for (const s of order) {
              const scroll = await s.t.benchmark({ workload: 'scroll', frames: 512 });
              result[s.config.key].scrollFencedFps = scroll.fencedFramesPerSecond;
            }
            rows.push({ repetition, round, order: order.map((s) => s.config.key), result });
          }
          // Streaming at display cadence: render submissions and write latency.
          const stream = {};
          for (const s of terms) {
            await new Promise((r) => setTimeout(r, 300));
            const before = s.frames;
            const begin = performance.now();
            let longest = 0;
            while (performance.now() - begin < 2000) {
              const at = performance.now();
              let text = '';
              for (let i = 0; i < 40; i++) text += logLine();
              await s.t.write(text);
              longest = Math.max(longest, performance.now() - at);
              await new Promise((r) => setTimeout(r, 16));
            }
            await s.t.flush();
            await new Promise((r) => setTimeout(r, 700));
            stream[s.config.key] = {
              renderSubmissions: s.frames - before,
              longestWriteMs: longest,
              announcements: s.announcements,
              mirrorRows: s.t.element.querySelector('.wraith-a11y-screen')?.childElementCount ?? 0,
              lastRowOk: /request/.test(await s.t.getText()),
            };
          }
          for (const s of terms) {
            await s.t.dispose();
            s.host.remove();
          }
          return { rows, stream };
        },
        {
          configs: configs.map((c) => ({
            key: `${c.build.name}/${c.sr ? 'on' : 'off'}`,
            module: c.build.module,
            sr: c.sr,
          })),
          rounds,
          repetition,
        },
      )
      .then((value) => ({ ...value, errors }));
  } finally {
    await page.close();
  }
}
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
try {
  for (let r = 0; r < repeats; r++) {
    const run = await measure(r);
    report.runs.push(...run.rows);
    report.stream = [...(report.stream ?? []), { repetition: r, ...run.stream }];
    console.log(JSON.stringify(run.stream));
    assert.deepEqual(run.errors, []);
    for (const [key, s] of Object.entries(run.stream)) {
      assert.ok(s.lastRowOk, key);
      if (key.endsWith('/on')) assert.equal(s.mirrorRows, 50);
    }
  }
  const keys = configs.map((c) => `${c.build.name}/${c.sr ? 'on' : 'off'}`);
  const metric = (key, name) => report.runs.map((r) => r.result[key][name]);
  const ratio = (key, name, against) =>
    median(report.runs.map((r) => r.result[key][name] / r.result[against][name]));
  const reference = keys.includes('baseline/off') ? 'baseline/off' : 'branch/off';
  report.summary = keys.map((key) => ({
    config: key,
    samples: report.runs.length,
    medianBulkMiBPerSecond: median(metric(key, 'bulkMiBPerSecond')),
    medianDenseFencedFps: median(metric(key, 'denseFencedFps')),
    medianScrollFencedFps: median(metric(key, 'scrollFencedFps')),
    [`pairedBulkRatioVs_${reference}`]: ratio(key, 'bulkMiBPerSecond', reference),
    [`pairedDenseRatioVs_${reference}`]: ratio(key, 'denseFencedFps', reference),
    [`pairedScrollRatioVs_${reference}`]: ratio(key, 'scrollFencedFps', reference),
    medianStreamRenderSubmissions: median(report.stream.map((s) => s[key].renderSubmissions)),
    medianStreamLongestWriteMs: median(report.stream.map((s) => s[key].longestWriteMs)),
    medianAnnouncements: median(report.stream.map((s) => s[key].announcements)),
  }));
  console.table(report.summary);
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/runs.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
