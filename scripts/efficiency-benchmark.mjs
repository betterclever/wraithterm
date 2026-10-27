// Resource-efficiency benchmark: CPU time, memory and GPU time attributable to
// a web terminal, per Chrome process, as a delta over the same harness page
// with no terminal mounted.
//
//   npx vite --port 5291 &   # serves demo/ (efficiency.html)
//   WRAITH_URL=http://127.0.0.1:5291 node scripts/efficiency-benchmark.mjs
//
// Every run is one renderer (or the 'none' baseline) and one workload in a fresh
// headed Chrome profile at devicePixelRatio 2. Rounds interleave renderers in a
// different order each round. Per run the runner reads, before and after the
// measured phase:
//  - CPU: cumulative user+system CPU seconds of every Chrome process from CDP
//    SystemInfo.getProcessInfo, by process type (browser, renderer, GPU,
//    utility). The renderer process includes the page's workers.
//  - Memory: macOS phys_footprint per pid (`footprint`), its graphics
//    categories (IOSurface, IOAccelerator, "(graphics)"), and RSS from ps.
//  - GPU time: AGXDeviceUserClient AppUsage accumulatedGPUTime per pid
//    (ioreg), summed per Chrome process, plus WindowServer for context.
//  - Machine state: load average, power source.
// Results append to .cache/efficiency/raw.jsonl (resumable); the final file is
// docs/benchmarks/resource-efficiency/results.json. scripts/efficiency-report.mjs
// computes baseline deltas and writes REPORT.md.
//
// Env: ROUNDS (3), WORKLOADS, RENDERERS, MAX_LOAD (6), PREFER_WAIT_S (20), MAX_WAIT_S (45),
// SHOTS_DIR, RAW (jsonl path), CHROME_PATH.
import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5291';
const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cache = resolve(root, '.cache/efficiency');
const raw = resolve(root, process.env.RAW ?? join(cache, 'raw.jsonl'));
const shots = resolve(root, process.env.SHOTS_DIR ?? join(cache, 'shots'));
const outDir = resolve(root, 'docs/benchmarks/resource-efficiency');
const rounds = Number(process.env.ROUNDS ?? 3);
const maxLoad = Number(process.env.MAX_LOAD ?? 6);
const preferWaitS = Number(process.env.PREFER_WAIT_S ?? 20);
const cores = cpus().length;
const maxWaitS = Number(process.env.MAX_WAIT_S ?? 45);
const scale = Number(process.env.SCALE ?? 1); // window length multiplier, smoke tests only
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SINGLE_RENDERERS = [
  'none',
  'wraith',
  'wraith-xterm',
  'xterm-webgl',
  'xterm-dom',
  'restty',
  'zem',
  'ghostty-web',
  'wterm',
  'wterm-ghostty',
];
const MULTI_RENDERERS = [
  'none',
  'wraith-pool',
  'wraith-fleet',
  'wraith-xterm',
  'xterm-webgl',
  'xterm-dom',
  'restty',
  'zem',
  'ghostty-web',
  'wterm',
  'wterm-ghostty',
];
const WORKLOADS = {
  idle: { kind: 'window', seconds: 30 },
  scroll10k: { kind: 'window', seconds: 10 },
  scroll100k: { kind: 'window', seconds: 10 },
  typing: { kind: 'window', seconds: 30 },
  logs: { kind: 'window', seconds: 20 },
  throughput: { kind: 'work', timeoutS: 240 },
  dense: { kind: 'window', seconds: 20 },
  unicode: { kind: 'work', timeoutS: 240 },
  multi16: { kind: 'window', seconds: 20, multi: true },
  multi64: { kind: 'window', seconds: 20, multi: true },
};
const workloads = process.env.WORKLOADS?.split(',') ?? Object.keys(WORKLOADS);
const only = process.env.RENDERERS?.split(',');

// ------------------------------------------------------------- measurement
const gpuTimesPy = `import json, plistlib, subprocess, re
r = subprocess.run(['/usr/sbin/ioreg', '-a', '-r', '-c', 'AGXDeviceUserClient'], capture_output=True, check=True)
out = {}
for c in plistlib.loads(r.stdout) or []:
    m = re.match(r'pid (\\d+), (.*)', c.get('IOUserClientCreator', ''))
    if not m: continue
    t = sum(u.get('accumulatedGPUTime', 0) for u in c.get('AppUsage', []) or [])
    k = m.group(1)
    out[k] = out.get(k, 0) + t
print(json.dumps(out))`;
/** Accumulated GPU time (ns) per pid, all AGX user clients. */
function gpuTimes() {
  return JSON.parse(
    execFileSync('python3', ['-c', gpuTimesPy], { encoding: 'utf8', maxBuffer: 16 << 20 }),
  );
}
function windowServerPid() {
  return Number(
    spawnSync('pgrep', ['-x', 'WindowServer'], { encoding: 'utf8' }).stdout.trim().split('\n')[0],
  );
}
const isGraphics = (name) => /graphics|IOSurface|IOAccelerator/.test(name);
/** phys_footprint and its graphics share per pid. */
async function footprints(pids) {
  const file = join(cache, `fp-${process.pid}.json`);
  spawnSync('footprint', ['-f', 'bytes', '-j', file, ...pids.map(String)], { stdio: 'ignore' });
  const out = {};
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    for (const p of j.processes ?? []) {
      let graphics = 0;
      for (const [name, c] of Object.entries(p.categories ?? {}))
        if (isGraphics(name)) graphics += c.dirty ?? 0;
      out[p.pid] = {
        footprint: p.auxiliary?.phys_footprint ?? p.footprint,
        peak: p.auxiliary?.phys_footprint_peak,
        graphics,
      };
    }
  } catch {}
  return out;
}
function rssByPid(pids) {
  const r = spawnSync('/bin/ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {
    encoding: 'utf8',
  }).stdout;
  return Object.fromEntries(
    r
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.trim().split(/\s+/).map(Number))
      .map(([p, k]) => [p, k * 1024]),
  );
}
async function snapshot(cdp, { memory = true } = {}) {
  const t = performance.now();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const procs = processInfo.map((p) => ({ pid: p.id, type: p.type, cpu: p.cpuTime }));
  const gpu = gpuTimes();
  const snap = {
    t,
    procs,
    gpuNs: Object.fromEntries(procs.map((p) => [p.pid, gpu[p.pid] ?? 0])),
    windowServerGpuNs: gpu[windowServerPid()] ?? null,
  };
  if (memory) {
    const pids = procs.map((p) => p.pid);
    snap.mem = await footprints(pids);
    snap.rss = rssByPid(pids);
  }
  return snap;
}
/** Aggregate one snapshot or the difference of two by Chrome process type. */
function byType(snap) {
  const out = {};
  for (const p of snap.procs) {
    const o = (out[p.type] ??= { n: 0, cpuS: 0, gpuNs: 0, footprint: 0, graphics: 0, rss: 0 });
    o.n++;
    o.cpuS += p.cpu;
    o.gpuNs += snap.gpuNs[p.pid] ?? 0;
    o.footprint += snap.mem?.[p.pid]?.footprint ?? 0;
    o.graphics += snap.mem?.[p.pid]?.graphics ?? 0;
    o.rss += snap.rss?.[p.pid] ?? 0;
  }
  return out;
}
function cpuGpuDelta(a, b) {
  const before = new Map(a.procs.map((p) => [p.pid, p]));
  const out = {};
  const changed = [];
  for (const p of b.procs) {
    const q = before.get(p.pid);
    if (!q) changed.push(`+${p.type}:${p.pid}`);
    const o = (out[p.type] ??= { cpuS: 0, gpuNs: 0 });
    o.cpuS += p.cpu - (q?.cpu ?? 0);
    o.gpuNs += (b.gpuNs[p.pid] ?? 0) - (a.gpuNs[p.pid] ?? 0);
  }
  for (const q of a.procs)
    if (!b.procs.some((p) => p.pid === q.pid)) changed.push(`-${q.type}:${q.pid}`);
  return {
    seconds: (b.t - a.t) / 1000,
    byType: out,
    processesChanged: changed,
    windowServerGpuNs: b.windowServerGpuNs - a.windowServerGpuNs,
  };
}

// ------------------------------------------------------------- machine state
function power() {
  const s = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' });
  return { ac: s.includes("'AC Power'"), line: s.split('\n')[1]?.trim() };
}
const otherBench = () =>
  spawnSync('pgrep', ['-f', 'node .*(fleet-benchmark|fleet-profile)\\.mjs'], {
    encoding: 'utf8',
  }).stdout.trim();
/** Wait for the Fleet GPU benchmark to finish and for AC power; then for a
 * 1-minute load average below MAX_LOAD (6) for up to PREFER_WAIT_S, below the
 * logical core count up to MAX_WAIT_S, and after that run regardless. The
 * machine is shared; every run records its load. */
async function waitTurn() {
  const started = Date.now();
  for (let i = 0; ; i++) {
    const bench = otherBench();
    const ac = power().ac;
    const load = loadavg()[0];
    const waited = (Date.now() - started) / 1000;
    if (
      !bench &&
      ac &&
      (load < maxLoad || (waited >= preferWaitS && load < cores) || waited >= maxWaitS)
    )
      return { waitedS: waited, loadGateMet: load < maxLoad, underCores: load < cores };
    if (i % 8 === 0)
      console.log(
        `  waiting: ${bench ? 'fleet benchmark running; ' : ''}${ac ? '' : 'on battery; '}load ${load.toFixed(1)} (${waited.toFixed(0)} s)`,
      );
    await sleep(15000);
  }
}

/** A fresh profile does start-up work in the browser process for several
 * seconds. Before mounting anything, wait until every Chrome process together
 * uses < 20 ms CPU per second for 3 consecutive seconds (at most 45 s). */
async function quiesce(cdp) {
  const total = async () =>
    (await cdp.send('SystemInfo.getProcessInfo')).processInfo.reduce((s, p) => s + p.cpuTime, 0);
  let prev = await total(),
    calm = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 45_000) {
    await sleep(1000);
    const now = await total();
    calm = now - prev < 0.02 ? calm + 1 : 0;
    prev = now;
    if (calm >= 3) return { seconds: (Date.now() - t0) / 1000, calm: true };
  }
  return { seconds: (Date.now() - t0) / 1000, calm: false };
}

// The Unicode workload's CJK fallback font: macOS's Arial Unicode, copied to
// the uncommitted cache and served by Vite.
const fallbackSrc = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf';
const fallbackFile = join(cache, 'fallback.ttf');
const fallbackUrl = `/@fs${fallbackFile}`;

// ------------------------------------------------------------- one run
async function run(type, workload, round) {
  const spec = WORKLOADS[workload];
  const gate = await waitTurn();
  const dataDir = join(tmpdir(), `wraith-efficiency-${process.pid}-${type}-${workload}`);
  await rm(dataDir, { recursive: true, force: true });
  const result = {
    round,
    type,
    workload,
    at: new Date().toISOString(),
    gate,
    loadBefore: loadavg(),
    power: power().line,
  };
  const context = await chromium.launchPersistentContext(dataDir, {
    executablePath: chromePath,
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
    args: [
      `--app=${base}/efficiency.html`,
      '--window-position=0,0',
      '--window-size=1728,1000',
      '--force-device-scale-factor=2',
      '--enable-unsafe-webgpu',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider',
    ],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    if (!page.url().includes('efficiency.html')) await page.goto(`${base}/efficiency.html`);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
    let crashed = false;
    page.on('crash', () => (crashed = true));
    await page.waitForFunction(() => window.efficiencyReady === true, null, { timeout: 60_000 });
    await page.bringToFront();
    // Browser-target session: SystemInfo is only available there.
    const cdp = await context.browser().newBrowserCDPSession();
    result.quiesce = await quiesce(cdp);
    const pageCdp = await context.newCDPSession(page);
    result.setup = await Promise.race([
      page.evaluate(
        ([t, w, o]) => window.efficiency.setup(t, w, o),
        [type, workload, workload === 'unicode' ? { fallbackFont: fallbackUrl } : {}],
      ),
      sleep(240_000).then(() => ({ timeout: true })),
    ]).catch((e) => ({ failed: String(e.message ?? e).slice(0, 300) }));
    if (result.setup.timeout || result.setup.failed || crashed) {
      result.gaveUp = crashed
        ? 'crashed'
        : result.setup.timeout
          ? 'setup timed out'
          : 'setup failed';
      result.errors = errors.slice(0, 5);
      return result;
    }
    // Settle, collect main-thread garbage, then measure.
    await sleep(3000);
    await pageCdp.send('HeapProfiler.collectGarbage').catch(() => {});
    await sleep(1000);
    const heapBefore = await pageCdp.send('Runtime.getHeapUsage').catch(() => null);
    const s0 = await snapshot(cdp);
    await page.evaluate(() => window.efficiency.begin());
    const samples = [];
    let phase;
    if (spec.kind === 'window') {
      const until = performance.now() + spec.seconds * scale * 1000;
      while (performance.now() < until - 2500) {
        await sleep(2000);
        const s = await snapshot(cdp);
        samples.push({ t: (s.t - s0.t) / 1000, byType: byType(s) });
      }
      await sleep(Math.max(0, until - performance.now()));
      const s1 = await snapshot(cdp);
      phase = await page.evaluate(() => window.efficiency.end());
      Object.assign(result, { s0: byType(s0), s1: byType(s1), delta: cpuGpuDelta(s0, s1) });
    } else {
      let finished = false;
      const work = Promise.race([
        page.evaluate(() => window.efficiency.done()),
        sleep(spec.timeoutS * 1000).then(() => ({ timeout: true })),
      ]).finally(() => (finished = true));
      while (!finished) {
        await Promise.race([sleep(2000), work]);
        if (finished) break;
        const s = await snapshot(cdp);
        samples.push({ t: (s.t - s0.t) / 1000, byType: byType(s) });
      }
      phase = await work;
      // Deferred work (frames, garbage collection) right after completion is
      // part of the cost; the baseline idle rate is subtracted for this tail.
      await sleep(500);
      const s1 = await snapshot(cdp);
      Object.assign(result, { s0: byType(s0), s1: byType(s1), delta: cpuGpuDelta(s0, s1) });
      if (phase.timeout) result.gaveUp = `did not finish in ${spec.timeoutS} s`;
    }
    result.phase = phase;
    result.samples = samples;
    result.heap = {
      before: heapBefore,
      after: await pageCdp.send('Runtime.getHeapUsage').catch(() => null),
    };
    result.check = await Promise.race([
      page.evaluate(() => window.efficiency.check()),
      sleep(30_000).then(() => ({ timeout: true })),
    ]).catch((e) => ({ failed: String(e.message ?? e).slice(0, 200) }));
    await mkdir(shots, { recursive: true });
    const shot = join(shots, `r${round}-${workload}-${type}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    result.shot = shot;
    result.crashed = crashed;
    result.errors = errors.slice(0, 5);
    result.loadAfter = loadavg();
    return result;
  } finally {
    await context.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- schedule
function shuffled(list, s) {
  const a = list.slice();
  let x = s * 2654435761;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) >>> 0;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
await mkdir(cache, { recursive: true });
if (!existsSync(fallbackFile)) await copyFile(fallbackSrc, fallbackFile);
const done = new Set();
if (existsSync(raw))
  for (const line of (await readFile(raw, 'utf8')).split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    done.add(`${r.round}|${r.workload}|${r.type}`);
  }
for (let round = 1; round <= rounds; round++)
  for (const workload of workloads) {
    const list = (
      WORKLOADS[workload].multi
        ? MULTI_RENDERERS
        : workload === 'idle'
          ? [...SINGLE_RENDERERS, 'static']
          : SINGLE_RENDERERS
    ).filter((t) => !only || only.includes(t));
    for (const type of shuffled(list, round * 31 + workload.length)) {
      const key = `${round}|${workload}|${type}`;
      if (done.has(key)) continue;
      let r = await run(type, workload, round);
      // A Fleet benchmark that started during the run invalidates it: repeat.
      while (otherBench()) {
        console.log(`  discarding r${round} ${workload} ${type}: fleet benchmark overlapped`);
        r = await run(type, workload, round);
      }
      await appendFile(raw, JSON.stringify(r) + '\n');
      done.add(key);
      const d = r.delta;
      const cpu = d ? Object.values(d.byType).reduce((s, x) => s + x.cpuS, 0) : NaN;
      console.log(
        `r${round} ${workload} ${type}: ${r.gaveUp ?? `${((cpu * 1000) / d.seconds).toFixed(0)} CPU-ms/s over ${d.seconds.toFixed(1)} s, renderer ${(r.s1.renderer?.footprint / 2 ** 20).toFixed(0)} MB, gpu-proc ${(r.s1.GPU?.footprint / 2 ** 20).toFixed(0)} MB, marker ${r.check?.marker}, retained ${r.check?.retained}`}, load ${r.loadBefore[0].toFixed(1)}`,
      );
    }
  }

// ------------------------------------------------------------- results.json
const runs = (await readFile(raw, 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const sha = async (f) =>
  createHash('sha256')
    .update(await readFile(resolve(root, f)))
    .digest('hex');
const version = async (p) =>
  JSON.parse(await readFile(resolve(root, 'node_modules', p, 'package.json'), 'utf8')).version;
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, 'results.json'),
  JSON.stringify(
    {
      measured: new Date().toISOString(),
      head: git('rev-parse', 'HEAD'),
      dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
      chrome: execFileSync(chromePath, ['--version'], { encoding: 'utf8' }).trim(),
      machine: {
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryGB: totalmem() / 2 ** 30,
        os: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
      },
      versions: Object.fromEntries(
        await Promise.all(
          [
            'wraithterm',
            '@xterm/xterm',
            '@xterm/addon-webgl',
            'restty',
            '@zem-sh/terminal',
            'ghostty-web',
            '@wterm/dom',
            '@wterm/core',
            '@wterm/ghostty',
          ].map(async (p) => [p, await version(p).catch(() => null)]),
        ),
      ),
      sources: Object.fromEntries(
        await Promise.all(
          [
            'packages/wraith/wasm/wraith_engine_bg.wasm',
            'demo/efficiency-bench.js',
            'demo/efficiency.html',
            'scripts/efficiency-benchmark.mjs',
          ].map(async (f) => [f, await sha(f)]),
        ),
      ),
      settings: {
        rounds,
        scale,
        maxLoad,
        preferWaitS,
        maxWaitS,
        window: '1728x1000',
        dpr: 2,
        workloads: WORKLOADS,
      },
      runs,
    },
    null,
    1,
  ) + '\n',
);
console.log(`wrote ${join(outDir, 'results.json')} (${runs.length} runs)`);
