// Summarize docs/benchmarks/replay/seek.json into summary.csv and a Markdown table.
//   node scripts/summarize-replay.mjs [report-dir]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'docs/benchmarks/replay';
const report = JSON.parse(await readFile(join(dir, 'seek.json'), 'utf8'));
const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
};
const rows = [];
for (const keyframes of [true, false]) {
  const runs = report.runs.filter((run) => run.keyframes === keyframes);
  for (const pattern of ['random', 'scrub']) {
    const samples = runs.flatMap((run) => run[pattern]);
    const parsed = samples.map((s) => s.parsedMs);
    const fenced = samples.map((s) => s.fencedMs);
    rows.push({
      config: keyframes ? 'keyframes' : 'from start',
      pattern,
      seeks: samples.length,
      parsedP50: percentile(parsed, 0.5),
      parsedP95: percentile(parsed, 0.95),
      parsedMax: Math.max(...parsed),
      fencedP50: percentile(fenced, 0.5),
      fencedP95: percentile(fenced, 0.95),
      fencedMax: Math.max(...fenced),
      bytesP95: percentile(
        samples.map((s) => s.bytes),
        0.95,
      ),
      keyframeRestores: samples.filter((s) => s.restored && s.keyframe > 0).length,
      startRestores: samples.filter((s) => s.restored && s.keyframe <= 0).length,
      forward: samples.filter((s) => !s.restored).length,
    });
  }
}
const columns = Object.keys(rows[0]);
await writeFile(
  join(dir, 'summary.csv'),
  [columns.join(','), ...rows.map((row) => columns.map((c) => row[c]).join(','))].join('\n') + '\n',
);
const ms = (value) => value.toFixed(1);
console.log(
  '| Seeks | Pattern | n | Parsed p50 / p95 / max ms | GPU-fenced p50 / p95 / max ms | Bytes p95 | Keyframe / start / forward |',
);
console.log('| --- | --- | --: | --: | --: | --: | --: |');
for (const row of rows)
  console.log(
    `| ${row.config} | ${row.pattern} | ${row.seeks} | ${ms(row.parsedP50)} / ${ms(row.parsedP95)} / ${ms(row.parsedMax)} | ${ms(row.fencedP50)} / ${ms(row.fencedP95)} / ${ms(row.fencedMax)} | ${(row.bytesP95 / 1024).toFixed(0)} KiB | ${row.keyframeRestores} / ${row.startRestores} / ${row.forward} |`,
  );
for (const run of report.runs.filter((r) => r.keyframes))
  console.log(
    `rep ${run.repetition}: mount ${run.mountMs.toFixed(0)} ms, keyframes ${JSON.stringify(run.keyframeStats)}`,
  );
console.log(
  JSON.stringify(
    { build: report.build, environment: report.environment, workload: report.workload },
    null,
    1,
  ),
);
