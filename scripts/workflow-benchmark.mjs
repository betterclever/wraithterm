import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, totalmem, release } from 'node:os';
import { createHash } from 'node:crypto';
import { workflowNames, normalizeText } from '../demo/workflow-bench.js';
import { pixelSummary, pixels as decodePixels } from './png.mjs';

const root = process.cwd(),
  base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const sourceRoot = process.env.WRAITH_SOURCE_ROOT ?? root;
const cols = Number(process.env.WRAITH_COLS ?? 160),
  rows = Number(process.env.WRAITH_ROWS ?? 50);
const output = process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/workflows';
const repetitions = Number(process.env.WRAITH_REPETITIONS ?? 5);
const dprs = (process.env.WRAITH_DPRS ?? '1,2').split(',').map(Number);
const types = (process.env.WRAITH_TYPES ?? 'dom,webgl,wraith,ghostty').split(',');
const cases = (
  process.env.WRAITH_CASES ??
  [...workflowNames, 'complex', 'churn', 'append', 'showcase', 'pipes'].join(',')
).split(',');
const phases = (process.env.WRAITH_PHASES ?? 'throughput,interaction,sustained').split(',');
const minMs = Number(process.env.WRAITH_MIN_MS ?? 1000),
  frames = Number(process.env.WRAITH_FRAMES ?? 512);
const keys = Number(process.env.WRAITH_KEYS ?? 40),
  sustainedMs = Number(process.env.WRAITH_SUSTAINED_MS ?? 30000);
assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
assert(
  Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    rows > 0 &&
    cols <= 512 &&
    rows <= 512 &&
    cols * rows <= 65536,
);
assert(phases.every((phase) => ['throughput', 'interaction', 'sustained'].includes(phase)));
assert(dprs.every((d) => d === 1 || d === 2));
assert(types.every((t) => ['dom', 'webgl', 'wraith', 'ghostty'].includes(t)));
assert(
  cases.every((c) =>
    [...workflowNames, 'complex', 'churn', 'append', 'showcase', 'pipes'].includes(c),
  ),
);
assert(
  minMs >= 0 &&
    minMs <= 30000 &&
    Number.isInteger(frames) &&
    frames >= 32 &&
    frames <= 32768 &&
    Number.isInteger(keys) &&
    keys >= 1 &&
    Number.isFinite(sustainedMs) &&
    sustainedMs >= 1000,
);
await mkdir(output, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = [
  'packages/wraith/src/xterm-renderer.ts',
  'packages/wraith/src/xterm-input.ts',
  'packages/wraith/src/index.ts',
  'packages/wraith/src/worker.ts',
  'packages/wraith/wasm/wraith_engine_bg.wasm',
  'demo/compare.js',
  'demo/workflow-bench.js',
  'demo/interaction-bench.js',
  'scripts/workflow-benchmark.mjs',
];
const fingerprint = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [path, sha(await readFile(`${sourceRoot}/${path}`))]),
    ),
  );
const metadata = {
  date: new Date().toISOString(),
  head:
    process.env.WRAITH_BUILD_HASH ??
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirtyFiles: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean),
  sources: await fingerprint(),
  cpu: cpus()[0].model,
  logicalCpus: cpus().length,
  memoryBytes: totalmem(),
  os: `${process.platform} ${release()}`,
  xterm: JSON.parse(await readFile('node_modules/@xterm/xterm/package.json')).version,
  webglAddon: JSON.parse(await readFile('node_modules/@xterm/addon-webgl/package.json')).version,
  ghostty: JSON.parse(await readFile('upstream.json')).ghostty,
  config: { repetitions, dprs, types, cases, phases, minMs, frames, keys, sustainedMs, cols, rows },
  methodology: {
    throughput:
      'Precomputed deterministic ANSI, warmed 32 updates; repeated blocks of 32, GPU-fenced every block. DOM forces layout and has no GPU-completion fence. Grid recorded in config. Legacy complex/churn/append/showcase/pipes use the existing fixed-frame comparison harness. Synchronous core throughput is distinct from worker SDK latency.',
    correctness:
      'Fixed-count replay text hashes compared with upstream DOM; WebGL viewport must match drawing-buffer dimensions. Initial real pixels checked for every renderer/DPR. Unicode11 enabled on xterm workflow cases; native Unicode glyph coverage is not certified by a text-state match.',
    latency:
      'Real Playwright keyboard events; key→onData, echo parse acknowledgement, public onRender notification, then next rAF opportunity. Native onRender is opt-in; notification observes submission, not GPU completion or actual display scanout. Output flood offers ~64KiB every 16ms with a 2MiB queue cap; achieved rates retained.',
    memory:
      'Eight public SDK terminals, 80x24 each, bounded 10000-line histories. Main-page JS heap (excluding native worker heaps and most GPU/Wasm allocations) and isolated Chrome process RSS sampled before/load/after disposal; RSS sums can double-count shared mappings. These are bounded-run observations, not proof of leak absence.',
    cpu: 'Isolated Chrome process CPU-time deltas / elapsed wall time. 100% means one busy logical CPU; also divided by logical CPU count for machine capacity. Process-set changes invalidate this estimate.',
    gpu: 'Device-wide Apple GPU driver utilization during sustained runs. Includes other apps and has an undocumented averaging window; cannot be attributed to this terminal process.',
    timing:
      'Headless Chrome with real GPU; no other benchmark runs concurrently. Browser performance.now precision applies. Desktop apps and device thermals are not controlled.',
  },
  results: [],
  errors: [],
};
const save = () => writeFile(`${output}/runs.json`, JSON.stringify(metadata, null, 2) + '\n');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execute = promisify(execFile);
async function gpuSnapshot() {
  if (process.platform !== 'darwin') return null;
  try {
    const script =
      "import json,plistlib,subprocess; ds=plistlib.loads(subprocess.check_output(['/usr/sbin/ioreg','-a','-r','-c','IOAccelerator','-d','1'])); print(json.dumps([{'name':d.get('IORegistryEntryName'),'devicePercent':d.get('PerformanceStatistics',{}).get('Device Utilization %'),'rendererPercent':d.get('PerformanceStatistics',{}).get('Renderer Utilization %')} for d in ds if 'Device Utilization %' in d.get('PerformanceStatistics',{})]))";
    return {
      at: Date.now(),
      devices: JSON.parse((await execute('python3', ['-c', script])).stdout),
    };
  } catch (error) {
    return { unavailable: String(error) };
  }
}
function cpuDelta(before, after, elapsedMs) {
  const prior = new Map(before.processInfo.map((p) => [p.id, p]));
  const stable =
    prior.size === after.processInfo.length && after.processInfo.every((p) => prior.has(p.id));
  if (!stable) return { stable: false, before: before.processInfo, after: after.processInfo };
  const byType = {};
  for (const p of after.processInfo)
    byType[p.type] =
      (byType[p.type] ?? 0) + ((p.cpuTime - prior.get(p.id).cpuTime) * 100000) / elapsedMs;
  const corePercent = Object.values(byType).reduce((sum, n) => sum + n, 0);
  return { stable: true, corePercent, machinePercent: corePercent / cpus().length, byType };
}
async function memory(cdp, browserCdp) {
  const usage = await cdp.send('Runtime.getHeapUsage');
  const processes = await browserCdp.send('SystemInfo.getProcessInfo');
  let rssBytes;
  try {
    rssBytes = execFileSync(
      'ps',
      ['-o', 'rss=', '-p', processes.processInfo.map((p) => p.id).join(',')],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\s+/)
      .reduce((sum, n) => sum + Number(n) * 1024, 0);
  } catch {}
  return {
    at: Date.now(),
    jsUsedBytes: usage.usedSize,
    jsTotalBytes: usage.totalSize,
    backingStorageBytes: usage.backingStorageSize,
    rssBytes,
  };
}
for (const dpr of dprs) {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
    headless: true,
    args: [`--force-device-scale-factor=${dpr}`],
  });
  const browserCdp = await browser.newBrowserCDPSession();
  const context = await browser.newContext({
    viewport: { width: 2600, height: 2100 },
    deviceScaleFactor: dpr,
  });
  const pageFor = async (type) => {
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/compare.html?type=${type}&workload=complex&cols=${cols}&rows=${rows}`);
    await page.waitForFunction(() => window.comparison?.ready || window.failure, undefined, {
      timeout: 30000,
    });
    const scene = await page.evaluate(() => window.comparison.ready);
    assert(scene, await page.evaluate(() => window.failure));
    metadata.userAgent ??= await page.evaluate(() => navigator.userAgent);
    metadata.adapter ??= await page.evaluate(() => window.comparison.adapterInfo());
    const cdp = await context.newCDPSession(page);
    return { page, errors, cdp };
  };
  const close = async (page) => {
    await page
      .evaluate(async () => {
        await window.comparison.interactions.interactionDispose();
        window.comparison.dispose();
      })
      .catch(() => {});
    await page.close();
  };
  try {
    if (phases.includes('throughput'))
      for (const name of cases)
        for (let repeat = 0; repeat < repetitions; repeat++) {
          const order = types.map((_, i) => types[(i + repeat) % types.length]);
          for (const type of order) {
            let page;
            try {
              const opened = await pageFor(type);
              page = opened.page;
              if (repeat === 0 && name === cases[0]) {
                const png = await page.locator('#scene').screenshot();
                const pixels = pixelSummary(png);
                assert(pixels.bright > 1000 && pixels.colors > 20, `Empty ${type} pixels`);
                await writeFile(`${output}/${type}-dpr${dpr}.png`, png);
              }
              const before = await browserCdp.send('SystemInfo.getProcessInfo'),
                start = performance.now();
              let run;
              if (workflowNames.includes(name))
                run = await page.evaluate((config) => window.comparison.workflow(config), {
                  name,
                  cols,
                  rows,
                  minMs,
                  frames,
                });
              else {
                const scene = await page.evaluate((config) => window.comparison.setup(config), {
                  type,
                  workload: name,
                  cols,
                  rows,
                });
                const legacy = await page.evaluate((config) => window.comparison.run(config), {
                  type,
                  workload: name,
                  cols,
                  rows,
                  frames,
                });
                run = {
                  ...legacy,
                  updatesPerSecond: legacy.pipelineUpdatesPerSecond,
                  renderer: type === 'wraith' ? 'webgpu' : type,
                  text: scene.text,
                  legacy: true,
                };
              }
              const after = await browserCdp.send('SystemInfo.getProcessInfo');
              run.cpu = cpuDelta(before, after, performance.now() - start);
              run.textSha256 = sha(normalizeText(run.text));
              delete run.text;
              run.phase = 'throughput';
              run.repeat = repeat;
              run.workload = name;
              run.pixelGeometryValid =
                !run.geometry ||
                (run.geometry.viewport[2] === run.geometry.drawingBuffer[0] &&
                  run.geometry.viewport[3] === run.geometry.drawingBuffer[1]);
              run.nativeUnicodeGlyphsUnverified = type === 'ghostty' && name === 'unicode';
              if (name === 'pipes') {
                const expected = await page.evaluate(() => window.comparison.pipesPixelProbe());
                const png = await page.locator('#scene').screenshot();
                const actual = decodePixels(png);
                let mismatches = 0,
                  checked = 0;
                for (let i = 0; i < expected.colors.length; i++) {
                  const [fg, bg] = expected.colors[i];
                  for (const [part, color] of [
                    [0.25, fg],
                    [0.75, bg],
                  ]) {
                    const x = Math.floor(
                      (expected.x + ((i % expected.cols) + 0.5) * expected.cellWidth) * dpr,
                    );
                    const y = Math.floor(
                      (expected.y + (Math.floor(i / expected.cols) + part) * expected.cellHeight) *
                        dpr,
                    );
                    const offset = (y * actual.width + x) * actual.bpp;
                    if (
                      x >= actual.width ||
                      y >= actual.height ||
                      [0, 1, 2].some(
                        (c) => Math.abs(actual.data[offset + c] - ((color >>> (c * 8)) & 255)) > 3,
                      )
                    )
                      mismatches++;
                    checked++;
                  }
                }
                run.pixelCheck = { checked, mismatches };
                if (repeat === 0 || mismatches)
                  await writeFile(`${output}/pipes-${type}-dpr${dpr}-r${repeat}.png`, png);
              }
              assert.deepEqual(opened.errors, []);
              metadata.results.push(run);
              console.log(
                `DPR${dpr} ${name} ${type} #${repeat + 1}: ${run.updatesPerSecond.toFixed(0)} ${run.gpuFenced ? 'GPU-fenced' : 'layout'} updates/s${run.pixelGeometryValid ? '' : ' INVALID GEOMETRY'}`,
              );
            } catch (error) {
              metadata.errors.push({
                phase: 'throughput',
                name,
                type,
                repeat,
                dpr,
                error: String(error),
              });
              console.error(String(error));
            } finally {
              if (page) await close(page);
              await save();
            }
          }
        }
    if (phases.includes('interaction') && dpr === 1)
      for (let repeat = 0; repeat < Math.min(repetitions, 3); repeat++)
        for (const type of types.map((_, i) => types[(i + repeat) % types.length])) {
          let page;
          try {
            const opened = await pageFor(type);
            page = opened.page;
            await page.evaluate((type) => window.comparison.interactionSetup(type), type);
            const run = { phase: 'interaction', type, repeat, dpr, modes: [] };
            for (const load of ['idle', 'flood']) {
              if (load === 'flood')
                await page.evaluate(() => window.comparison.interactions.startFlood());
              await delay(200);
              await page.evaluate(() => window.comparison.interactions.resetLatency());
              for (let key = 0; key < keys; key++) {
                await page.evaluate((id) => window.comparison.interactions.armKey(id), key);
                await page.keyboard.press(key % 2 ? 'b' : 'a');
                await page.evaluate(() => window.comparison.interactions.keyResult());
              }
              const summary = await page.evaluate(() =>
                window.comparison.interactions.latencySummary(),
              );
              const samples = await page.evaluate(() =>
                window.comparison.interactions.latencySamples(),
              );
              const flood =
                load === 'flood'
                  ? await page.evaluate(() => window.comparison.interactions.stopFlood())
                  : undefined;
              if (flood) assert.deepEqual(flood.errors, []);
              run.modes.push({ load, summary, samples, flood });
              console.log(
                `${type} ${load} input p95 ${summary.inputMs.p95.toFixed(2)}ms, render notification p95 ${summary.renderNotificationMs.p95.toFixed(2)}ms`,
              );
            }
            run.operations = await page.evaluate(() =>
              window.comparison.interactions.interactionOperations(),
            );
            assert.deepEqual(opened.errors, []);
            metadata.results.push(run);
          } catch (error) {
            metadata.errors.push({ phase: 'interaction', type, repeat, error: String(error) });
            console.error(String(error));
          } finally {
            if (page) await close(page);
            await save();
          }
        }
    if (phases.includes('sustained') && dpr === 1)
      for (const type of types) {
        let page;
        try {
          const opened = await pageFor(type);
          page = opened.page;
          await page.evaluate(
            (type) => window.comparison.interactionSetup(type, { count: 8, cols: 80, rows: 24 }),
            type,
          );
          await opened.cdp.send('HeapProfiler.collectGarbage');
          await delay(5000);
          const gpuIdle = await gpuSnapshot(),
            gpuSamples = [];
          const before = await memory(opened.cdp, browserCdp),
            samples = [];
          const cpuBefore = await browserCdp.send('SystemInfo.getProcessInfo'),
            start = performance.now();
          let iterations = 0,
            bytes = 0,
            lastSample = start;
          while (performance.now() - start < sustainedMs) {
            const step = await page.evaluate(
              (n) => window.comparison.interactions.sustainedStep(n),
              iterations++,
            );
            bytes += step.bytes;
            await delay(Math.max(0, start + iterations * (1000 / 30) - performance.now()));
            if (performance.now() - lastSample > 2000) {
              samples.push(await memory(opened.cdp, browserCdp));
              gpuSamples.push(await gpuSnapshot());
              lastSample = performance.now();
            }
          }
          const elapsedMs = performance.now() - start;
          const cpuAfter = await browserCdp.send('SystemInfo.getProcessInfo'),
            loaded = await memory(opened.cdp, browserCdp);
          await page.evaluate(() => window.comparison.interactions.interactionDispose());
          await opened.cdp.send('HeapProfiler.collectGarbage');
          await delay(1000);
          const disposed = await memory(opened.cdp, browserCdp);
          assert.deepEqual(opened.errors, []);
          metadata.results.push({
            phase: 'sustained',
            type,
            dpr,
            terminals: 8,
            targetStepsPerSecond: 30,
            iterations,
            bytes,
            elapsedMs,
            before,
            samples,
            loaded,
            disposed,
            cpu: cpuDelta(cpuBefore, cpuAfter, elapsedMs),
            gpu: { idle: gpuIdle, samples: gpuSamples, after: await gpuSnapshot() },
          });
          console.log(
            `${type} eight terminals: ${(bytes / 1048576 / (elapsedMs / 1000)).toFixed(2)} MiB/s for ${(elapsedMs / 1000).toFixed(1)}s, disposed JS heap ${(disposed.jsUsedBytes / 1048576).toFixed(1)}MiB`,
          );
        } catch (error) {
          metadata.errors.push({ phase: 'sustained', type, error: String(error) });
          console.error(String(error));
        } finally {
          if (page) await close(page);
          await save();
        }
      }
  } finally {
    await browser.close();
  }
}
assert.deepEqual(await fingerprint(), metadata.sources, 'Sources changed during benchmark');
await save();
if (metadata.errors.length) process.exitCode = 1;
console.log(
  `Saved ${metadata.results.length} runs and ${metadata.errors.length} errors to ${output}/runs.json`,
);
