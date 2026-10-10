import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = resolve(process.env.WRAITH_REPORT_DIR ?? join(root, 'docs/benchmarks/comparison'));
const raw = JSON.parse(await readFile(join(report, 'utilization.json'), 'utf8'));
const avg = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const names = {
  dom: 'xterm DOM',
  webgl: 'xterm + WebGL',
  wraith: 'Wraith compatible Terminal',
  ghostty: 'Wraith libghostty core',
};
const rows = [];
for (const rate of raw.rates) {
  for (const type of ['dom', 'webgl', 'wraith', 'ghostty']) {
    const runs = raw.results.filter((r) => r.type === type && r.rate === rate);
    if (!runs.length) continue;
    const cpus = runs.map((r) => r.loaded.cpu.totalPercent);
    const gpuSamples = runs.flatMap((r) => r.loaded.samples.gpu);
    const idleSamples = runs.flatMap((r) => [
      ...r.idleBefore.samples.gpu,
      ...r.idleAfter.samples.gpu,
    ]);
    const values = gpuSamples.map((r) => r.devicePercent);
    rows.push({
      rate,
      type,
      repetitions: runs.length,
      updatesPerSecond: avg(runs.map((r) => r.loaded.result.updatesPerSecond)),
      cpuPercent: avg(cpus),
      cpuMinPercent: Math.min(...cpus),
      cpuMaxPercent: Math.max(...cpus),
      machineCapacityPercent: avg(cpus) / raw.logicalCpus,
      rendererCpuPercent: avg(runs.map((r) => r.loaded.cpu.byTypePercent.renderer ?? 0)),
      gpuProcessCpuPercent: avg(runs.map((r) => r.loaded.cpu.byTypePercent.GPU ?? 0)),
      idleCpuPercent: avg(
        runs.flatMap((r) => [r.idleBefore.cpu.totalPercent, r.idleAfter.cpu.totalPercent]),
      ),
      cpuMsPerUpdate: avg(
        runs.map((r) => (r.loaded.cpu.totalPercent * 10) / r.loaded.result.updatesPerSecond),
      ),
      deviceGpuPercent: avg(values),
      deviceGpuMinPercent: Math.min(...values),
      deviceGpuMaxPercent: Math.max(...values),
      idleDeviceGpuPercent: avg(idleSamples.map((r) => r.devicePercent)),
      gpuSamples: gpuSamples.length,
      idleGpuSamples: idleSamples.length,
    });
  }
}
await writeFile(
  join(report, 'utilization-summary.json'),
  JSON.stringify({ ...raw, results: undefined, rows }, null, 2) + '\n',
);
const fields = Object.keys(rows[0]);
await writeFile(
  join(report, 'utilization-summary.csv'),
  fields.join(',') +
    '\n' +
    rows.map((row) => fields.map((f) => row[f]).join(',')).join('\n') +
    '\n',
);
const table = (selected) =>
  [
    '| Renderer | Achieved updates/s | Chrome CPU % | Machine CPU capacity % | GPU total % | GPU idle baseline % |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...selected.map(
      (r) =>
        `| ${names[r.type]} | ${r.updatesPerSecond.toFixed(1)} | ${r.cpuPercent.toFixed(1)} | ${r.machineCapacityPercent.toFixed(2)} | ${r.deviceGpuPercent.toFixed(1)} | ${r.idleDeviceGpuPercent.toFixed(1)} |`,
    ),
  ].join('\n');
const reportText = `# CPU and GPU utilization: dense terminal scene

Measured ${raw.date.slice(0, 10)} on the Apple M5 Max machine with ${raw.logicalCpus} logical CPUs, Chrome 155, headless, DPR 1. The same 240×80 scene used in [the speed comparison](REPORT.md) changes all 19,200 cells, with about 4,800 SGR changes and 210 KiB of UTF-8 input per update. Each renderer has ${raw.repetitions} repetitions per rate, ${raw.durationMs / 1000} seconds of load, and ${raw.idleMs / 1000} seconds of idle sampling before and after. Order rotates between repetitions. Scene text hashes and canvas sizes match; WebGPU/WebGL modes and browser errors are checked.

**CPU percentages measure all processes in the dedicated benchmark Chrome instance. 100% is one fully occupied logical core, so values can exceed 100%.** The machine-capacity column divides that number by ${raw.logicalCpus}; it is the share of nominal CPU scheduling capacity, not the OS's overall CPU usage, power or equal-speed core capacity. Measurements include browser rendering, raster and GPU-process CPU work. An unrelated application is excluded from this Chrome CPU total, although shared-machine contention can affect results.

**GPU percentages are whole-device driver counters, including other applications.** The paired idle baseline is substantial and fluctuates. These readings cannot establish Wraith's own GPU utilization or a GPU-efficiency ranking. The GPU-process CPU column in the detailed data is CPU usage, not GPU activity. No per-process GPU percentage is claimed. The nonprivileged counters are Device/Renderer/Tiler Utilization % from IORegistry; the driver's averaging window is undocumented. Privileged powermetrics is unavailable in this session.

The baseline windows stop issuing terminal updates. The DOM renderer still has queued raster work after load: its post-load Chrome CPU remains around 97% in the 30-update/s runs. Those post-load windows are a cooldown observation, not a fully settled DOM baseline. GPU paths have less than 1% mean Chrome CPU in their before/after windows. A zero device-GPU sample in a Wraith 120-target run is retained; the device-counter ranges are in the raw summary. Background activity and counter variability prevent app-specific GPU conclusions.

## Target: 30 logical updates/s

${table(rows.filter((r) => r.rate === 30))}

Compare achieved rates before interpreting CPU usage as an equal-work comparison. The DOM path can fall below the requested rate; GPU paths are checked by their measured rate rather than assumed to keep up.

## Target: 120 logical updates/s

${table(rows.filter((r) => r.rate === 120))}

This exercises the raw parsing/rendering pipeline with a manually controlled scheduler. It does **not** certify 120 display FPS or public-API frame pacing. The libghostty core is run directly on the main thread without SDK worker/transport overhead.

The fixed-rate harness uses nested setTimeout calls, which include browser timer delays/clamping and GPU-fence waits. Its achieved rate is the result of the renderer and this scheduler together, not a renderer-only capacity ceiling. The unpaced mode below exercises a different schedule. The sample does not establish consistent 120 Hz presentation for the compatible API.

## Unpaced throughput

${table(rows.filter((r) => r.rate === 0))}

This mode yields to the browser every 8 updates and waits for GPU completion every 32 updates. DOM painting can coalesce updates. Rates include the sampling harness and browser paint work, so they are separate measurements from the earlier short speed benchmark. Higher CPU usage here can accompany more completed work; it is not by itself a regression.

## CPU detail and variability

| Target | Renderer | Renderer-process CPU % | GPU-process CPU % | CPU range between repetitions % | Aggregate CPU ms/update |
| --- | --- | ---: | ---: | ---: | ---: |
${rows.map((r) => `| ${r.rate || 'unpaced'} | ${names[r.type]} | ${r.rendererCpuPercent.toFixed(1)} | ${r.gpuProcessCpuPercent.toFixed(1)} | ${r.cpuMinPercent.toFixed(1)}–${r.cpuMaxPercent.toFixed(1)} | ${r.cpuMsPerUpdate.toFixed(2)} |`).join('\n')}

Aggregate CPU ms/update sums time across threads/processes and can exceed elapsed latency. Two repetitions on one busy machine are exploratory, not a cross-device or sustained-power guarantee. All observed repetitions remain in the raw report. No idle-baseline subtraction is presented as app-specific GPU usage.

## Reproduce

Start the local demo with npm run dev, then:

\x60\x60\x60sh
WRAITH_USAGE_MS=8000 WRAITH_IDLE_MS=3000 npm run benchmark:usage
node scripts/summarize-utilization.mjs
\x60\x60\x60

GPU collection currently requires macOS with exposed IOAccelerator PerformanceStatistics. The command reads counters and launches a separate Chrome instance; it does not need sudo. WRAITH_USAGE_RATES, WRAITH_REPETITIONS, WRAITH_REPORT_DIR and CHROME_PATH configure the runs. The CPU calculation is 100 × delta cumulative process CPU seconds / delta wall seconds, using Chrome's [SystemInfo.getProcessInfo](https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/#method-getProcessInfo), whose counter includes every thread in a process.

Raw samples and cumulative CPU counters: [utilization.json](utilization.json). Aggregates and ranges: [utilization-summary.json](utilization-summary.json), [utilization-summary.csv](utilization-summary.csv). Wasm SHA-256: ${raw.wasmSha256}.
`;
await writeFile(join(report, 'UTILIZATION.md'), reportText);
console.log(JSON.stringify(rows, null, 2));
