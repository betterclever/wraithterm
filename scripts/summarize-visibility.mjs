import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
const root = process.argv[2] ?? 'docs/benchmarks/native-visibility';
const r = JSON.parse(await readFile(`${root}/paired/runs.json`));
assert.equal(r.results.length, r.config.repeats * r.config.modes.length * r.builds.length);
assert.equal(r.builds.length, 2);
const median = (a) => {
  const s = [...a].sort((a, b) => a - b),
    h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const sum = (a) => a.reduce((a, b) => a + b, 0);
const range = (a) => `${Math.min(...a).toFixed(1)}–${Math.max(...a).toFixed(1)}`;
const ref = r.results[0];
for (const v of r.results) {
  assert.equal(v.textHash, ref.textHash);
  assert.equal(v.historyHash, ref.historyHash);
  assert.equal(v.acknowledgedBytes, ref.acknowledgedBytes);
  assert.equal(v.batches, ref.batches);
  assert(v.pixels.bright > 100);
  assert.deepEqual(v.errors, []);
  if (v.build === 'after' && v.mode !== 'visible') assert(v.frames.every((n) => n === 0));
  if (v.mode === 'visible') assert(v.frames.every((n) => n > 0));
}
const rows = [];
for (const mode of r.config.modes) {
  const group = (build) =>
    r.results
      .filter((v) => v.mode === mode && v.build === build)
      .sort((a, b) => a.repeat - b.repeat);
  const a = group('before'),
    b = group('after');
  assert.equal(a.length, r.config.repeats);
  assert.equal(b.length, r.config.repeats);
  const pairs = a
    .map((v, i) => ({ a: v, b: b[i] }))
    .filter((p) => p.a.cpu.stable && p.b.cpu.stable);
  assert(pairs.length > 0, 'No stable CPU pairs');
  rows.push({
    mode,
    repetitions: a.length,
    stableCpuPairs: pairs.length,
    beforeSubmissions: median(a.map((v) => sum(v.frames))),
    afterSubmissions: median(b.map((v) => sum(v.frames))),
    beforeBatchesPerSecond: median(a.map((v) => v.batchesPerSecond)),
    afterBatchesPerSecond: median(b.map((v) => v.batchesPerSecond)),
    beforeCpuPercent: median(pairs.map((p) => p.a.cpu.totalPercent)),
    afterCpuPercent: median(pairs.map((p) => p.b.cpu.totalPercent)),
    beforeCpuRange: range(pairs.map((p) => p.a.cpu.totalPercent)),
    afterCpuRange: range(pairs.map((p) => p.b.cpu.totalPercent)),
    pairedCpuReductionPercent: median(
      pairs.map((p) => 100 * (1 - p.b.cpu.totalPercent / p.a.cpu.totalPercent)),
    ),
    beforeMachineCapacityPercent: median(pairs.map((p) => p.a.cpu.machineCapacityPercent)),
    afterMachineCapacityPercent: median(pairs.map((p) => p.b.cpu.machineCapacityPercent)),
  });
}
const keys = Object.keys(rows[0]);
await writeFile(
  `${root}/summary.csv`,
  [keys.join(','), ...rows.map((v) => keys.map((k) => v[k]).join(','))].join('\n') + '\n',
);
await writeFile(
  `${root}/summary.json`,
  JSON.stringify({ builds: r.builds, config: r.config, rows }, null, 2) + '\n',
);
let text = `# Native hidden-panel efficiency\n\n${r.cpu}, ${r.logicalCpus} logical CPUs, ${r.os}; ${r.userAgent}. Before \`${r.builds[0].head}\`, after \`${r.builds[1].head}\`; exact SDK/worker/Wasm hashes are retained in the [raw report](paired/runs.json). The engine/Wasm is identical.\n\nEight 80×24 native terminals, each with its own worker and GPU device, receive 64 log lines per batch at 12 batches/s. Each record offers ${r.config.steps} batches over ${r.config.steps / r.config.hz} seconds and acknowledges ${(ref.acknowledgedBytes / 1048576).toFixed(2)} MiB across the eight terminals. Five repetitions alternate build order, using a fresh isolated Chrome per record. Visible canvases fit inside a 2200×900 viewport; offscreen means 20,000px below it, and clipped means an overflow-hidden ancestor with no positive canvas intersection.\n\n## Equal-work results\n\nSubmission counts are medians **per record across all eight terminals**, during load only. CPU columns are run medians; the reduction column is the median of paired ratios, so it can differ from the ratio of displayed medians. CPU percentages sum cumulative user/kernel CPU time across all processes in the isolated Chrome, divided by elapsed wall time. **100% means one logical core**, not the whole machine or GPU utilization.\n\n| Panel state | Submissions before → after | Chrome CPU before → after | Paired CPU reduction | Batches/s before → after |\n|---|---:|---:|---:|---:|\n`;
for (const v of rows)
  text += `| ${v.mode} | ${v.beforeSubmissions} → ${v.afterSubmissions} | ${v.beforeCpuPercent.toFixed(1)}% → ${v.afterCpuPercent.toFixed(1)}% | ${v.pairedCpuReductionPercent.toFixed(1)}% | ${v.beforeBatchesPerSecond.toFixed(2)} → ${v.afterBatchesPerSecond.toFixed(2)} |\n`;
text += `\nAll records acknowledge identical byte counts; viewport and scrolled-history hashes match across both builds and all modes. Hidden normal submissions fall to zero after intersection delivery. This is avoided GPU work, not faster visible rendering. CPU ranges, machine-capacity percentages and stable-process pair counts remain in [summary.csv](summary.csv). A negative reduction is increased measured CPU time, not a benefit.\n\n## Behavior and checks\n\nGeometry-based canvas intersection combines with document visibility. Parsing, terminal-generated output, retained history, search, selection, resize, accessibility mirrors and stats continue while hidden. Explicit flush retains its force-render/GPU-fence behavior. On reveal the worker requests a fresh presentation even when no new write arrives and its state is clean. This request survives fences and unsuccessful/held render attempts.\n\nEvery record checks written content and scrollback, explicitly flushes outside timing, then reveals without writing and checks actual nonempty canvas pixels. Final hidden records require a fresh reveal submission from each terminal. The separate browser test covers 13 groups: normal and paused writes, hidden search/resize/selection/mirror/flush, clean reveal, real pixels, zero-area edge to one-pixel intersection, overflow clipping, combined page visibility, concurrent writes/fences, disposal with late observer delivery, initialization during deferred fonts, worker failure and unavailable/throwing observers. Both document-only fallbacks are exercised through hide/resume. Native interaction/search/display and native/compatible installed consumers pass; 66 SDK tests, typecheck and production builds pass. [Validation](validation.json).\n\n## Limits\n\n- This benchmark measures normal submission counts and Chrome **CPU time**; it does not measure GPU-completed FPS, physical display presentation, or per-process GPU usage. The GPU process column in raw CPU counters is CPU work.\n- Five short runs on a shared desktop are an exploratory efficiency measurement. Other applications remain active and can alter scheduling/thermals. Source builds and offered work are held fixed, and order alternates; close visible-control CPU differences are not a reliable improvement claim. CPU estimates exclude pairs if the browser process set changes; raw counters are retained for audit.\n- CPU remains nonzero because parsing, workers, stats, input and accessibility may still do useful work. No memory/worker suspension is claimed. Intersection callbacks are asynchronous; initial/in-flight frames may precede pausing.\n- Ordinary IntersectionObserver checks geometry, including clipping and display:none. It does not detect opacity, CSS visibility:hidden, another overlapping panel or another application covering the browser. Partial intersections continue rendering the complete terminal. If the observer is unavailable, document-level pausing remains.\n\n## Reproduce\n\nBuild SDK/demo, freeze baseline dist plus index.ts, worker.ts and the Wasm artifact under .cache/visibility-before, and serve baseline on 5198 and final dist on 5196. Keep both unchanged during timing.\n\n\`\`\`sh\nWRAITH_URL=http://127.0.0.1:5196 npm run test:native-visibility\nWRAITH_BEFORE_URL=http://127.0.0.1:5198 \\\nWRAITH_BEFORE_SOURCE_ROOT=.cache/visibility-before \\\nWRAITH_BEFORE_HASH=92f85e35caf37a0cdbdf7aed52c4cd682dae01db \\\nWRAITH_REPETITIONS=5 npm run benchmark:visibility\nnode scripts/summarize-visibility.mjs\n\`\`\`\n\nThe initial 30-write CSS-hidden probe submitted all 30 frames. A one-repetition pilot confirmed equal state/work before the retained final matrix; it is not used for the reported ratios. Screenshots remain local and ignored.\n`;
const control = JSON.parse(await readFile(`${root}/visible-settled/runs.json`));
assert.equal(control.results.length, 6);
const a = control.results.filter((v) => v.build === 'before').sort((a, b) => a.repeat - b.repeat);
const b = control.results.filter((v) => v.build === 'after').sort((a, b) => a.repeat - b.repeat);
for (const v of control.results) {
  assert(v.cpu.stable);
  assert.deepEqual(v.errors, []);
  assert.equal(v.textHash, control.results[0].textHash);
  assert.equal(v.historyHash, control.results[0].historyHash);
  assert.equal(v.acknowledgedBytes, control.results[0].acknowledgedBytes);
}
const settled = {
  config: control.config,
  builds: control.builds,
  beforeCpuMedian: median(a.map((v) => v.cpu.totalPercent)),
  afterCpuMedian: median(b.map((v) => v.cpu.totalPercent)),
  beforeCpuRange: range(a.map((v) => v.cpu.totalPercent)),
  afterCpuRange: range(b.map((v) => v.cpu.totalPercent)),
  pairedCpuReductionPercent: median(
    a.map((v, i) => 100 * (1 - b[i].cpu.totalPercent / v.cpu.totalPercent)),
  ),
  beforeBatchRate: median(a.map((v) => v.batchesPerSecond)),
  afterBatchRate: median(b.map((v) => v.batchesPerSecond)),
  beforeSubmissions: a.map((v) => sum(v.frames)),
  afterSubmissions: b.map((v) => sum(v.frames)),
};
await writeFile(`${root}/visible-settled/summary.json`, JSON.stringify(settled, null, 2) + '\n');
text = text.replace(
  '## Behavior and checks',
  `## Longer visible control\n\nThe short matrix measured a 7.5% paired increase in visible Chrome CPU time. A follow-up keeps the SDK/worker/Wasm unchanged, settles for five seconds after mounting, and measures 180 batches over 15 seconds. Three alternating pairs / six records retain their separate [raw data](visible-settled/runs.json) and [summary](visible-settled/summary.json). CPU medians are ${settled.beforeCpuMedian.toFixed(1)}% before and ${settled.afterCpuMedian.toFixed(1)}% after; ranges ${settled.beforeCpuRange}% and ${settled.afterCpuRange}%. The median paired reduction is ${settled.pairedCpuReductionPercent.toFixed(1)}% (negative means an increase). Both achieve ${settled.beforeBatchRate.toFixed(2)} / ${settled.afterBatchRate.toFixed(2)} batches/s; byte counts and terminal/history hashes match. One pair improves CPU time and two increase it. In the middle pair renderer/GPU process CPU is almost identical, with the increase concentrated in the browser process. The final pair increases across processes. These overlapping, shared-host samples do not establish the cause or a visible CPU advantage; a quiet-machine check remains advisable. No visible throughput improvement is claimed for this milestone.\n\n## Behavior and checks`,
);
text = text.replace(
  'node scripts/summarize-visibility.mjs\n```',
  `WRAITH_BEFORE_URL=http://127.0.0.1:5198 \\\nWRAITH_BEFORE_SOURCE_ROOT=.cache/visibility-before \\\nWRAITH_BEFORE_HASH=92f85e35caf37a0cdbdf7aed52c4cd682dae01db \\\nWRAITH_REPETITIONS=3 WRAITH_STEPS=180 WRAITH_SETTLE_MS=5000 \\\nWRAITH_VISIBILITY_MODES=visible \\\nWRAITH_REPORT_DIR=docs/benchmarks/native-visibility/visible-settled \\\nnpm run benchmark:visibility\nnode scripts/summarize-visibility.mjs\n\`\`\``,
);
await writeFile(`${root}/REPORT.md`, await format(text, { parser: 'markdown', printWidth: 100 }));
console.log(JSON.stringify(rows, null, 2));
