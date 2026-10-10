import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = resolve(process.env.WRAITH_REPORT_DIR ?? join(root, 'docs/benchmarks/comparison'));
await mkdir(report, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const durationMs = Number(process.env.WRAITH_USAGE_MS ?? 10000);
const idleMs = Number(process.env.WRAITH_IDLE_MS ?? 4000);
const repetitions = Number(process.env.WRAITH_REPETITIONS ?? 2);
const rates = (process.env.WRAITH_USAGE_RATES ?? '30,0,120').split(',').map(Number);
const selectedTypes = process.env.WRAITH_USAGE_TYPES?.split(',');
assert(rates.every((n) => Number.isFinite(n) && n >= 0));
assert(durationMs >= 1000 && idleMs >= 1000 && repetitions >= 1);
assert.equal(process.platform, 'darwin', 'GPU counter collection currently requires macOS');
const logicalCpus = Number((await execute('/usr/sbin/sysctl', ['-n', 'hw.logicalcpu'])).stdout);
const gpuCode = `import json, plistlib, subprocess
r = subprocess.run(['/usr/sbin/ioreg', '-a', '-r', '-c', 'IOAccelerator', '-d', '1'], capture_output=True, check=True)
result = []
for device in plistlib.loads(r.stdout):
    counters = device.get('PerformanceStatistics', {})
    if 'Device Utilization %' in counters:
        result.append({'name': device.get('IORegistryEntryName'), 'devicePercent': counters['Device Utilization %'], 'rendererPercent': counters.get('Renderer Utilization %'), 'tilerPercent': counters.get('Tiler Utilization %')})
print(json.dumps(result))`;
const gpuSnapshot = async () => {
  const before = performance.now();
  const value = JSON.parse((await execute('python3', ['-c', gpuCode])).stdout);
  assert.equal(value.length, 1, 'Expected exactly one GPU with utilization counters');
  assert(Number.isFinite(value[0].devicePercent), 'Missing GPU utilization');
  return { atMs: (before + performance.now()) / 2, ...value[0] };
};
await gpuSnapshot();
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const cdp = await browser.newBrowserCDPSession();
const cpuSnapshot = async () => {
  const before = performance.now();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  return { atMs: (before + performance.now()) / 2, processes: processInfo };
};
const cpuUsage = (start, end) => {
  const ids = (v) => v.processes.map((p) => p.id).sort((a, b) => a - b);
  assert.deepEqual(ids(start), ids(end), 'Chrome processes changed during the sampling window');
  const previous = new Map(start.processes.map((p) => [p.id, p.cpuTime]));
  const wallSeconds = (end.atMs - start.atMs) / 1000;
  const byTypePercent = {};
  for (const p of end.processes) {
    const seconds = p.cpuTime - previous.get(p.id);
    assert(seconds >= 0, 'CPU counter regressed');
    byTypePercent[p.type] = (byTypePercent[p.type] ?? 0) + (seconds / wallSeconds) * 100;
  }
  const totalPercent = Object.values(byTypePercent).reduce((a, b) => a + b, 0);
  return {
    wallSeconds,
    totalPercent,
    machineCapacityPercent: totalPercent / logicalCpus,
    byTypePercent,
  };
};
async function measure(operation) {
  const cpuStart = await cpuSnapshot();
  const gpu = [],
    cpu = [cpuStart];
  let done = false;
  const work = operation().finally(() => {
    done = true;
  });
  while (!done) {
    await Promise.race([pause(1000), work]);
    if (done) break;
    const samples = await Promise.all([cpuSnapshot(), gpuSnapshot()]);
    cpu.push(samples[0]);
    gpu.push(samples[1]);
  }
  const result = await work;
  const cpuEnd = await cpuSnapshot();
  cpu.push(cpuEnd);
  assert(gpu.length > 0, 'No GPU samples captured');
  return {
    result,
    cpu: cpuUsage(cpuStart, cpuEnd),
    gpu: {
      deviceMeanPercent: mean(gpu.map((s) => s.devicePercent)),
      deviceMinPercent: Math.min(...gpu.map((s) => s.devicePercent)),
      deviceMaxPercent: Math.max(...gpu.map((s) => s.devicePercent)),
      rendererMeanPercent: mean(gpu.map((s) => s.rendererPercent)),
      tilerMeanPercent: mean(gpu.map((s) => s.tilerPercent)),
    },
    samples: { cpu, gpu },
  };
}
const results = [],
  errors = [];
const metadata = {
  date: new Date().toISOString(),
  logicalCpus,
  headless: true,
  grid: { cols: 240, rows: 80, cells: 19200 },
  dpr: 1,
  workload: 'complex',
  durationMs,
  idleMs,
  repetitions,
  rates,
  cpuDefinition:
    'Sum of cumulative user+kernel CPU-time deltas for all processes in this isolated Chrome instance divided by wall time; 100% = one occupied logical core. Machine-capacity percentage divides by logical core count.',
  gpuDefinition:
    'Device-wide Apple GPU driver PerformanceStatistics via IORegistry, sampled approximately once per second. Includes all applications; idle deltas are contextual observations, not per-process attribution. Driver counter averaging window is undocumented.',
  measurement:
    'Raw parser + full redraw with scheduler disabled, warmed 32 frames. Fixed-rate modes yield every update; unlimited mode yields every 8 and GPU-fences every 32. These are logical updates, not display FPS. Ghostty uses the main-thread core without SDK worker/IPC.',
  wasmSha256: createHash('sha256')
    .update(await readFile(join(root, 'packages/wraith/wasm/wraith_engine_bg.wasm')))
    .digest('hex'),
  results,
  errors,
};
const save = () =>
  writeFile(join(report, 'utilization.json'), JSON.stringify(metadata, null, 2) + '\n');
try {
  const context = await browser.newContext({
    viewport: { width: 2600, height: 2100 },
    deviceScaleFactor: 1,
  });
  let referenceText;
  for (const rate of rates) {
    const types = (
      rate === 120 ? ['webgl', 'wraith', 'ghostty'] : ['dom', 'webgl', 'wraith', 'ghostty']
    ).filter((type) => !selectedTypes || selectedTypes.includes(type));
    assert(types.length, 'No renderer selected');
    for (let repeat = 0; repeat < repetitions; repeat++) {
      const order = types.map((_, i) => types[(i + repeat) % types.length]);
      for (const type of order) {
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        page.on('console', (m) => {
          if (m.type() === 'error') pageErrors.push(m.text());
        });
        try {
          await page.goto(
            `${process.env.WRAITH_URL ?? 'http://127.0.0.1:5173'}/compare.html?type=${type}&workload=complex`,
          );
          await page.waitForFunction(() => window.comparison?.ready, undefined, { timeout: 30000 });
          const scene = await page.evaluate(() => window.comparison.ready);
          assert(scene, await page.evaluate(() => window.failure));
          referenceText ??= scene.text;
          assert.equal(scene.text, referenceText, `${type}: scene differs`);
          assert.deepEqual(scene.dimensions.device.canvas, { width: 2160, height: 1600 });
          await page.evaluate(() => window.comparison.profile(32));
          await pause(1500);
          metadata.adapter ??= await page.evaluate(() => window.comparison.adapterInfo());
          metadata.userAgent ??= await page.evaluate(() => navigator.userAgent);
          const idleBefore = await measure(() => pause(idleMs));
          const loaded = await measure(() =>
            page.evaluate((config) => window.comparison.utilization(config), {
              durationMs,
              targetUpdatesPerSecond: rate,
            }),
          );
          await pause(1000);
          const idleAfter = await measure(() => pause(idleMs));
          assert.deepEqual(pageErrors, [], `${type}: browser errors`);
          const result = {
            type,
            repeat,
            rate,
            scene: {
              textSha256: createHash('sha256').update(scene.text).digest('hex'),
              bytesPerFrame: scene.bytesPerFrame,
              sgrChangesPerFrame: scene.sgrChangesPerFrame,
              canvas: scene.dimensions.device.canvas,
            },
            idleBefore,
            loaded,
            idleAfter,
          };
          results.push(result);
          await save();
          console.log(
            `${rate || 'unlimited'} updates/s ${type} #${repeat + 1}: ${loaded.result.updatesPerSecond.toFixed(1)} achieved; Chrome CPU ${loaded.cpu.totalPercent.toFixed(1)}% (${loaded.cpu.machineCapacityPercent.toFixed(2)}% of machine); GPU total ${loaded.gpu.deviceMeanPercent.toFixed(1)}% / idle ${((idleBefore.gpu.deviceMeanPercent + idleAfter.gpu.deviceMeanPercent) / 2).toFixed(1)}%`,
          );
        } catch (e) {
          errors.push({ type, repeat, rate, error: String(e), pageErrors });
          await save();
          throw e;
        } finally {
          await page.evaluate(() => window.comparison?.dispose()).catch(() => {});
          await page.close();
        }
      }
    }
  }
} finally {
  await cdp.detach().catch(() => {});
  await browser.close();
}
console.log(`Saved ${results.length} utilization runs with raw counter samples.`);
