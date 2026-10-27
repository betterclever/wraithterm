// Overhead of OSC 133 command blocks on scroll workloads. Runs alternating
// fresh pages for a baseline SDK build (WRAITH_BASELINE_DIST, e.g. a compiled
// copy of origin/main with its Wasm) and the current build:
//   stream        60,000 plain lines written through write(), then flush()
//                 (parse + GPU-fenced render; no OSC 133 present)
//   scroll        the engine's built-in scroll benchmark (GPU-fenced frames)
//   stream-osc133 current build only: the same lines as 600 command blocks
// Frames are GPU-completed (fenced) submissions, not displayed frames.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const root = resolve(import.meta.dirname, '..');
const baseline = process.env.WRAITH_BASELINE_DIST;
const runs = Number(process.env.WRAITH_RUNS ?? 7);
const out = resolve(
  root,
  process.env.WRAITH_REPORT ?? 'docs/benchmarks/command-blocks/overhead-raw.json',
);
const builds = [
  ...(baseline ? [{ name: 'baseline', dist: resolve(baseline) }] : []),
  { name: 'current', dist: resolve(root, 'packages/wraith/dist') },
];
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: process.env.WRAITH_HEADFUL !== '1',
});
async function measure(build, osc133) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/commands.html?static=1`);
  await page.waitForFunction(() => window.wraith, null, { timeout: 30000 });
  const result = await page.evaluate(
    async ({ url, osc133 }) => {
      await window.wraith.dispose();
      const { Wraith } = await import(/* @vite-ignore */ url);
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px;z-index:9';
      document.body.append(host);
      const term = await Wraith.mount(host, { fit: false, cols: 120, rows: 36 });
      const line = (i) =>
        `\x1b[38;5;${(i % 216) + 16}m${String(i).padStart(8, '0')}\x1b[0m ${'stream '.repeat(15)}\r\n`;
      const chunks = [];
      let chunk = '',
        bytes = 0;
      for (let i = 0; i < 60000; i++) {
        if (osc133 && i % 100 === 0)
          chunk +=
            (i ? '\x1b]133;D;0\x07' : '') +
            '\x1b]133;A\x07$ \x1b]133;B\x07seq\r\n\x1b]133;C;cmdline_url=seq\x07';
        chunk += line(i);
        if (chunk.length > 65536) {
          chunks.push(chunk);
          bytes += chunk.length;
          chunk = '';
        }
      }
      chunks.push(chunk + (osc133 ? '\x1b]133;D;0\x07\x1b]133;A\x07$ ' : ''));
      bytes += chunks.at(-1).length;
      await term.flush();
      const start = performance.now();
      await Promise.all(chunks.map((c) => term.write(c)));
      await term.flush();
      const streamMs = performance.now() - start;
      const blocks = typeof term.commands === 'function' ? (await term.commands()).length : 0;
      const scroll = osc133
        ? undefined
        : await term.benchmark({ workload: 'scroll', frames: 2000, warmup: 128 });
      await term.dispose();
      return {
        streamMs,
        streamMiBPerSecond: bytes / 1048576 / (streamMs / 1000),
        bytes,
        blocks,
        scroll,
        userAgent: navigator.userAgent,
      };
    },
    { url: `/@fs${build.dist}/index.js`, osc133 },
  );
  await page.close();
  if (errors.length) throw new Error(errors.join('\n'));
  return result;
}
const samples = [];
try {
  for (let run = 0; run < runs; run++) {
    // Alternate order so drift does not favour one build.
    const order = run % 2 ? [...builds].reverse() : builds;
    for (const build of order) {
      const r = await measure(build, false);
      samples.push({ run, build: build.name, workload: 'plain', ...r });
      console.log(
        build.name,
        'plain',
        r.streamMiBPerSecond.toFixed(1),
        'MiB/s',
        r.scroll?.fencedFramesPerSecond.toFixed(0),
        'fenced fps',
      );
    }
    const r = await measure(builds.at(-1), true);
    samples.push({ run, build: 'current', workload: 'osc133', ...r });
    console.log('current osc133', r.streamMiBPerSecond.toFixed(1), 'MiB/s', r.blocks, 'blocks');
  }
} finally {
  await browser.close();
}
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const summary = {};
for (const key of ['baseline:plain', 'current:plain', 'current:osc133']) {
  const [build, workload] = key.split(':');
  const set = samples.filter((s) => s.build === build && s.workload === workload);
  if (!set.length) continue;
  summary[key] = {
    runs: set.length,
    streamMiBPerSecondMedian: median(set.map((s) => s.streamMiBPerSecond)),
    streamMsMedian: median(set.map((s) => s.streamMs)),
    ...(workload === 'plain' && {
      scrollFencedFramesPerSecondMedian: median(set.map((s) => s.scroll.fencedFramesPerSecond)),
      scrollCpuP50MsMedian: median(set.map((s) => s.scroll.cpuP50Ms)),
      scrollCpuP95MsMedian: median(set.map((s) => s.scroll.cpuP95Ms)),
    }),
  };
}
const report = {
  date: new Date().toISOString(),
  head: sh('git', ['rev-parse', 'HEAD']),
  dirty: sh('git', ['status', '--porcelain']) !== '',
  baselineHead: baseline ? sh('cat', [resolve(baseline, '../HEAD')]) : undefined,
  wasmSha256: {
    current: await hash(resolve(root, 'packages/wraith/wasm/wraith_engine_bg.wasm')),
    ...(baseline && {
      baseline: await hash(resolve(baseline, '../wasm/wraith_engine_bg.wasm')),
    }),
  },
  hardware: {
    model: sh('sysctl', ['-n', 'hw.model']),
    cpu: sh('sysctl', ['-n', 'machdep.cpu.brand_string']),
    os: `${sh('sw_vers', ['-productName'])} ${sh('sw_vers', ['-productVersion'])}`,
  },
  browser: { version: browser.version(), headless: process.env.WRAITH_HEADFUL !== '1' },
  workload: {
    grid: '120x36, fit:false, 1000x600 CSS px host, deviceScaleFactor 1',
    stream: '60,000 lines, 256-color SGR + 120 columns, ~64 KiB write() chunks, then flush()',
    scroll: "term.benchmark({ workload: 'scroll', frames: 2000, warmup: 128 })",
    osc133: 'stream with an OSC 133 A/B/C/D block every 100 lines (600 blocks)',
    note: 'stream timing includes parsing and a final GPU-fenced render; scroll frames are GPU-completed submissions fenced every 32, not displayed frames',
  },
  summary,
  samples,
};
await mkdir(resolve(out, '..'), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
