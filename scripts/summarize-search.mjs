import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { format } from 'prettier';
const root = process.argv[2] ?? 'docs/benchmarks/native-search';
const read = async (phase) => JSON.parse(await readFile(`${root}/${phase}/runs.json`));
const before = await read('before'),
  after = await read('after'),
  countOnly = await read('count-only');
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    half = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
};
const fmt = (n) => (n < 0.05 ? '<0.1' : n.toFixed(n < 1 ? 2 : 1));
const cases = [
  [9000, false, '9,000 short lines'],
  [9000, true, '9,000 wrapped Unicode lines'],
  [90000, false, '90,000 short lines'],
];
function group(study, lines, wrapped, type, mode = 'all-count') {
  return study.results.filter(
    (r) =>
      r.fixture.lines === lines &&
      r.fixture.wrapped === wrapped &&
      r.type === type &&
      r.mode === mode,
  );
}
assert.equal(before.results.length, 108);
assert.equal(after.results.length, 180);
assert(
  after.results.every((r) => r.samples.every((s) => s.validCount)),
  'Exclude incorrect results',
);
assert.equal(countOnly.results.length, 60);
assert(countOnly.results.every((r) => r.samples.every((s) => s.validCount)));
const rows = [];
for (const [phase, study] of [
  ['before', before],
  ['after', after],
  ['count-only', countOnly],
])
  for (const [lines, wrapped] of cases)
    for (const type of ['dom', 'webgl', 'wraith', 'ghostty']) {
      const runs = group(
        study,
        lines,
        wrapped,
        type,
        phase === 'count-only' ? 'count-only' : 'all-count',
      );
      const p50 = runs.map((r) => r.summary.p50);
      rows.push({
        phase,
        head: study.head,
        lines,
        wrapped,
        type,
        repetitions: runs.length,
        medianMs: median(p50),
        minRunMedianMs: Math.min(...p50),
        maxRunMedianMs: Math.max(...p50),
        firstQueryMedianMs: median(runs.map((r) => r.samples[0].elapsedMs)),
        subsequentQueryMedianMs: median(
          runs.flatMap((r) => r.samples.slice(1).map((s) => s.elapsedMs)),
        ),
        incorrectSamples: runs.flatMap((r) => r.samples).filter((s) => !s.validCount).length,
      });
    }
const columns = Object.keys(rows[0]);
await writeFile(
  `${root}/summary.csv`,
  [columns.join(','), ...rows.map((r) => columns.map((k) => r[k]).join(','))].join('\n') + '\n',
);
const value = (lines, wrapped, type) =>
  rows.find(
    (r) => r.phase === 'after' && r.lines === lines && r.wrapped === wrapped && r.type === type,
  );
let report = `# Native search latency\n\n${after.cpu}, ${after.logicalCpus} logical CPUs, ${after.os}; ${after.userAgent}. Upstream xterm ${after.xterm}, Search addon ${after.searchAddon}.\n\nBaseline \`${before.head}\`: three rotated repetitions, 108 records. Final \`${after.head}\`: five rotated repetitions, 180 records. Exact worker, C bridge, Wasm and harness hashes are in each raw file; final records also fingerprint the pinned Ghostty patch. The original 82.8 ms workflow observation used a different query set; this controlled baseline measures 76.4 ms for short 9,000-line history.\n\n## Counted-search API comparison\n\nMedian of each repetition's median over nine distinct needles, including an absent needle. Each terminal starts with the same written corpus. The first needle builds text caches; later needles can reuse them. These are API response times in milliseconds, not GPU fences or presented frames.\n\n| History | xterm DOM | xterm WebGL | Wraith compatible | Wraith native | WebGL / native |\n|---|---:|---:|---:|---:|---:|\n`;
for (const [lines, wrapped, label] of cases) {
  const values = ['dom', 'webgl', 'wraith', 'ghostty'].map((t) => value(lines, wrapped, t));
  report += `| ${label} | ${values.map((r) => fmt(r.medianMs)).join(' | ')} | ${(values[1].medianMs / values[3].medianMs).toFixed(1)}× |\n`;
}
report += `\nXterm's public SearchAddon only reports all-match counts when decorations are enabled. Those calls also create match decorations; native reports the full count and selects a match without decorating every match. This compares the counted-search API contract, **not identical implementation work or isolated substring algorithms**. All queries stay below xterm's 1,000-highlight cap. Counts, misses and selected text passed in every final run. The Unicode fixture contains CJK and a combining mark and wraps to two physical rows per logical line; glyph conformance is not inferred from matching text.\n\n## First query after writing\n\nThe first counted query in each fresh terminal, before either path has built its search text cache:\n\n| History | xterm WebGL | Wraith native |\n|---|---:|---:|\n`;
for (const [lines, wrapped, label] of cases)
  report += `| ${label} | ${fmt(value(lines, wrapped, 'webgl').firstQueryMedianMs)} | ${fmt(value(lines, wrapped, 'ghostty').firstQueryMedianMs)} |\n`;
report += `\n## Counting without decorations\n\nA stricter diagnostic on build \`${countOnly.head}\` uses the pinned xterm search engine directly to enumerate matches without markers, decorations, result-array allocation or selection. Native still uses its public API, including worker messaging, full counts and selection. Five rotated repetitions, 60 records / 540 samples; all counts pass. This is a private-API diagnostic, not a supported xterm integration.\n\n| History | xterm WebGL engine count | Wraith native API |\n|---|---:|---:|\n`;
for (const [lines, wrapped, label] of cases)
  report += `| ${label} | ${fmt(median(group(countOnly, lines, wrapped, 'webgl', 'count-only').map((r) => r.summary.p50)))} | ${fmt(median(group(countOnly, lines, wrapped, 'ghostty', 'count-only').map((r) => r.summary.p50)))} |\n`;
report += `\nPlain-log counting is approximately tied: 0.5 ms on 9,000 lines and 4.3 vs 4.1 ms on 90,000, with overlapping run-median ranges. Do not claim a reliable plain-count lead. Wrapped-line counting remains about 6.8× faster (13.6 vs 2.0 ms). The very first 90,000-line query is 34.5 ms on both paths in this diagnostic. The larger public-API gains include work xterm performs for decorations and finding/selecting the next result after its full-count pass. [Raw undecorated diagnostic](count-only/runs.json). The earlier one-repetition diagnostic pilot is retained with its uncommitted harness source patch.\n`;
report += `\n## Before and after native\n\n| History | Before median | After median | Before / after |\n|---|---:|---:|---:|\n`;
for (const [lines, wrapped, label] of cases) {
  const a = rows.find(
    (r) =>
      r.phase === 'before' && r.lines === lines && r.wrapped === wrapped && r.type === 'ghostty',
  );
  const b = value(lines, wrapped, 'ghostty');
  report += `| ${label} | ${fmt(a.medianMs)}${a.incorrectSamples ? ' (incorrect counts)' : ''} | ${fmt(b.medianMs)} | ${a.incorrectSamples ? 'excluded' : (a.medianMs / b.medianMs).toFixed(0) + '×'} |\n`;
}
report += `\nThe wrapped baseline double-counted matches in overlap pages: six incorrect counted-query samples, plus six in its next-only phase where native still counts. Its speedup ratio is excluded. The fix moves the history frontier past every page already loaded by the active search. An earlier interrupted probe is retained under preliminary/ with its failure record.\n\n## Simpler next-match searches and navigation\n\nXterm without decorations can stop after its next match. Native still returns a complete count, so these calls do different work. Median API times:\n\n| History | xterm WebGL next only | Wraith native with count |\n|---|---:|---:|\n`;
for (const [lines, wrapped, label] of cases)
  report += `| ${label} | ${fmt(median(group(after, lines, wrapped, 'webgl', 'next-only').map((r) => r.summary.p50)))} | ${fmt(median(group(after, lines, wrapped, 'ghostty', 'next-only').map((r) => r.summary.p50)))} |\n`;
report += `\nXterm remains faster at next-only search on short-line histories. Warm navigation runs 24 repetitions of the same needle: medians on xterm and native are often below the browser's approximately 0.1 ms timer granularity, with native wrapped navigation around 0.1 ms. Zero samples mean below measurable resolution, not zero latency. Do not claim a reliable navigation ranking. All-count runs precede next-only, so the latter has warmed search text on both paths.\n\n## Implementation and limits\n\n- A MessageChannel replaces nested zero-delay timers. Each task processes a 2 ms CPU slice plus at most one bounded bridge-step overshoot, then yields through the serial worker queue. Initial needle setup is synchronous; this is not a hard deadline for every Ghostty operation. New searches coalesce pending work. Input, writes, resize, cancellation, disposal and asynchronous GPU fences remain serialized.\n- Search caches canonical UTF-8 pages and byte-to-cell maps across needles, up to 32 MiB of payload and 2,048 entries per terminal, plus metadata and working buffers. Clear before every write/resize, reset or screen transition carried in VT input. Entries remain after clearing the search UI and are released on mutation or disposal. Cache allocation failure falls back to ordinary scanning. Histories larger than the cap still work and may churn the cache. This is an explicit memory-for-speed tradeoff.\n- Host invalidation supplies active-area dirty tracking, and per-needle Horspool tables avoid rebuilding skip tables for every page/match. ASCII case folding and byte-exact non-ASCII semantics are preserved.\n- The 90,000-line browser test proves a real key reaches onData before a cold long scan completes; separate cases cover writes/reflow/fences, cancellation, reset and disposal. Rust tests exercise wrapped-overlap counts, cache invalidation and eviction beyond the payload cap.\n- This does not measure continuously changing histories, CPU utilization, GPU completion or physical display latency. Desktop thermals and other applications are not controlled. Final run-median ranges and every individual sample remain in summary.csv and raw JSON; small submillisecond differences are approximate. Baseline and final runs were sequential, not paired/interleaved.\n\n## Reproduce\n\nBuild with npm run build, npm run optimize, npm run build:sdk and npm run build:demo; serve dist on 5196. Run WRAITH_URL=http://127.0.0.1:5196 WRAITH_REPETITIONS=5 npm run benchmark:search. Run node scripts/summarize-search.mjs to regenerate this report and summary.csv. Native search correctness: WRAITH_URL=http://127.0.0.1:5196 npm run test:native-search. Full commands and validation records are in validation.json.\n\nRaw data: [baseline](before/runs.json), [final](after/runs.json), [per-study summary](summary.csv), [validation](validation.json).\n`;
await writeFile(`${root}/REPORT.md`, await format(report, { parser: 'markdown', printWidth: 100 }));
console.log(
  `Reviewed ${before.results.length + after.results.length + countOnly.results.length} records; all final counts valid.`,
);
