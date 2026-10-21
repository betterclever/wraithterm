import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, release } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
const video = resolve(import.meta.dirname, '..'),
  repo = resolve(video, '..');
const raw = JSON.parse(
  await readFile(resolve(video, '.cache/hype/compare-bench/chrome.json'), 'utf8'),
);
if (raw.errors.length || raw.results.length !== 36) throw Error('Comparison timing is incomplete');
const median = (a) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
const sources = {};
for (const f of [
  'demo/compare.js',
  'demo/showcase.js',
  'scripts/compare-renderers.mjs',
  'packages/wraith/src/xterm.ts',
  'packages/wraith/src/xterm-print.ts',
  'packages/wraith/src/xterm-renderer.ts',
  'packages/wraith/wasm/wraith_engine_bg.wasm',
])
  sources[f] = createHash('sha256')
    .update(await readFile(resolve(repo, f)))
    .digest('hex');
const groups = [];
for (const workload of ['complex', 'showcase', 'scroll']) {
  const renderers = {};
  for (const type of ['dom', 'webgl', 'wraith', 'ghostty']) {
    const runs = raw.results.filter((r) => r.type === type && r.workload === workload);
    if (runs.length !== 3 || new Set(runs.map((r) => r.contentSha256)).size !== 1)
      throw Error('Invalid run group');
    renderers[type] = {
      updatesPerSecond: runs.map((r) => r.pipelineUpdatesPerSecond),
      medianUpdatesPerSecond: median(runs.map((r) => r.pipelineUpdatesPerSecond)),
      cpuP50Ms: runs.map((r) => r.pipelineCpuMs.p50),
      medianCpuP50Ms: median(runs.map((r) => r.pipelineCpuMs.p50)),
    };
  }
  const lowerThroughputRatio =
    Math.min(...renderers.wraith.updatesPerSecond) / Math.max(...renderers.webgl.updatesPerSecond);
  const lowerCpuRatio =
    Math.min(...renderers.dom.cpuP50Ms) / Math.max(...renderers.wraith.cpuP50Ms);
  groups.push({
    workload,
    renderers,
    lowerThroughputRatio,
    lowerCpuRatio,
    throughputHeadline: Math.floor(lowerThroughputRatio * 10) / 10,
    cpuHeadline: Math.floor(lowerCpuRatio),
  });
}
let adapterProbe;
if (process.argv.includes('--probe')) {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 2400, height: 1900 } });
    await page.goto(
      `${process.env.WRAITH_URL ?? 'http://127.0.0.1:5199'}/compare.html?type=webgl&workload=complex`,
    );
    await page.evaluate(() => window.comparison.ready);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    if (userAgent !== raw.userAgent) throw Error('Adapter probe browser differs from benchmark');
    adapterProbe = {
      date: new Date().toISOString(),
      ...(await page.evaluate(() => window.comparison.adapterInfo())),
    };
  } finally {
    await browser.close();
  }
}
const record = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  cpu: cpus()[0].model,
  logicalCpus: cpus().length,
  os: `${process.platform} ${release()}`,
  sources,
  methodology:
    'Three serial repetitions per renderer/workload, rotating renderer order; 240x80 cells/DPR1/shared font. Warmed synchronous cores with precomputed eight-variant input; parse+draw included, scheduler disabled. GPU throughput fences every32 submissions plus final fence. DOM CPU time includes parse+render+forced layout, not compositor paint. WebGL throughput headline rounds DOWN slowest Wraith / fastest xterm WebGL. DOM CPU headline rounds DOWN fastest xterm DOM p50 / slowest Wraith p50. Short synthetic bursts, not display FPS, public worker throughput or universal speed. Capturing and video rendering paused during measurement; unrelated desktop processes may run. Visible text and canvas geometry match; glyph/style pixels are only a nonblank/color sanity check.',
  groups,
  raw,
  adapterProbe,
};
await writeFile(
  resolve(video, 'claims/hype-comparison.json'),
  JSON.stringify(record, null, 2) + '\n',
);
console.log(
  groups.map(({ workload, throughputHeadline, cpuHeadline }) => ({
    workload,
    throughputHeadline,
    cpuHeadline,
  })),
);
