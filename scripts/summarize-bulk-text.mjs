import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
const root = process.argv[2] ?? 'docs/benchmarks/bulk-text';
const study = JSON.parse(await readFile(`${root}/paired/runs.json`));
const median = (a) => {
  const s = [...a].sort((x, y) => x - y),
    h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const range = (a) => `${Math.min(...a).toFixed(1)}–${Math.max(...a).toFixed(1)}`;
assert.equal(study.results.length, 400);
for (const r of study.results) {
  assert.equal(r.publicHash, r.replayHash);
  assert.equal(
    r.publicHash,
    study.results.find(
      (x) =>
        x.type === 'dom' && x.cols === r.cols && x.provider === r.provider && x.kind === r.kind,
    ).publicHash,
  );
}
const rows = [];
for (const [cols, height] of study.config.grids)
  for (const provider of study.config.providers)
    for (const kind of study.config.cases) {
      const group = (build, type) =>
        study.results
          .filter(
            (r) =>
              r.build === build &&
              r.type === type &&
              r.cols === cols &&
              r.provider === provider &&
              r.kind === kind,
          )
          .sort((a, b) => a.repeat - b.repeat);
      const before = group('before', 'wraith'),
        after = group('after', 'wraith');
      const domBefore = group('before', 'dom'),
        domAfter = group('after', 'dom');
      for (const a of [before, after, domBefore, domAfter]) assert.equal(a.length, 5);
      const ratios = after.map((r, i) => r.parseMiBPerSecond / before[i].parseMiBPerSecond);
      rows.push({
        cols,
        rows: height,
        provider,
        kind,
        repetitions: 5,
        beforeMiBPerSecond: median(before.map((r) => r.parseMiBPerSecond)),
        afterMiBPerSecond: median(after.map((r) => r.parseMiBPerSecond)),
        pairedParseSpeedup: median(ratios),
        pairedParseRange: range(ratios),
        domNormalizedSpeedup: median(
          ratios.map(
            (r, i) => r / (domAfter[i].parseMiBPerSecond / domBefore[i].parseMiBPerSecond),
          ),
        ),
        beforePublicMs: median(before.map((r) => r.publicMs)),
        afterPublicMs: median(after.map((r) => r.publicMs)),
        beforePublicRange: range(before.map((r) => r.publicMs)),
        afterPublicRange: range(after.map((r) => r.publicMs)),
        pairedPublicSpeedup: median(after.map((r, i) => before[i].publicMs / r.publicMs)),
      });
    }
const columns = Object.keys(rows[0]);
await writeFile(
  `${root}/summary.csv`,
  [columns.join(','), ...rows.map((r) => columns.map((k) => r[k]).join(','))].join('\n') + '\n',
);
let report = `# Bulk text across wrapped rows\n\n${study.cpu}, ${study.logicalCpus} logical CPUs, ${study.os}; ${study.userAgent}. Pinned xterm ${study.xterm}. Baseline: \`${study.builds[0].head}\`; final: \`${study.builds[1].head}\`.\n\nThe compatible profile now bulk-writes fixed-width ASCII and box/block glyphs across rows, delegating each actual wrap boundary to upstream. The unchanged single-row path remains compact. This milestone does not change the native Ghostty profile, Rust engine or Wasm artifact.\n\n## Paired production results\n\nFive repetitions per case, two grids, two providers and stock DOM controls: 400 records. Baseline and final production pages alternate within the same browser; renderer order also rotates. Tables report median throughput and median **per-repetition** speedup, so the speedup can differ from the ratio of displayed medians. DOM-normalized speedup divides each paired ratio by its stock-DOM control ratio.\n\nDefault Unicode 6 provider, compatible profile:\n\n| Grid | Workload | Before MiB/s | After MiB/s | Paired speedup | DOM-normalized | Public callback before / after ms |\n|---|---|---:|---:|---:|---:|---:|\n`;
for (const r of rows.filter((r) => r.provider === '6'))
  report += `| ${r.cols}×${r.rows} | ${r.kind} | ${r.beforeMiBPerSecond.toFixed(1)} | ${r.afterMiBPerSecond.toFixed(1)} | ${r.pairedParseSpeedup.toFixed(2)}× | ${r.domNormalizedSpeedup.toFixed(2)}× | ${r.beforePublicMs.toFixed(1)} / ${r.afterPublicMs.toFixed(1)} |\n`;
report += `\nWarm wrapped parsing improves about **1.6–1.9×** here. The public 4 MiB write callback improves about **1.5–1.8×** in paired ratios. Short colored logs and no-wrap are effectively unchanged after the DOM control. The Unicode 11 provider deliberately falls back: normalized parser ratios range from ${Math.min(...rows.filter((r) => r.provider === '11').map((r) => r.domNormalizedSpeedup)).toFixed(2)}× to ${Math.max(...rows.filter((r) => r.provider === '11').map((r) => r.domNormalizedSpeedup)).toFixed(2)}×. These are not universal terminal or rendering speedups.\n\n## What was measured\n\n- Production SDK pages, 80×24 and 160×50, scrollback 1,000, stock monospace at 15px, cursor blink disabled. Each record creates a fresh terminal.\n- Public paste: 1 MiB ASCII through bracketed-paste onData and an application write echo; framing is checked. Public write: 4 MiB ASCII. No-wrap: 1 MiB ASCII with autowrap disabled. Logs: 16,384 colored short lines. Blocks: nine box/block glyphs repeated 32,768 times. MiB counts encoded UTF-8 bytes, so rates across different fixtures are not equivalent cell throughput.\n- Public time ends at the parse acknowledgement. Two animation frames and the GPU fence occur outside that interval. The separate warm parser phase disables rendering, warms four iterations, and measures sixteen synchronous parse calls. Neither measurement is GPU-completed FPS or display presentation.\n- After measurement, all bounded history raw cell words, combined strings, extended attributes, wrap flags and cursor/viewport state are hashed. Every public result matches its synchronous replay and upstream DOM across both builds and providers. Hashing is outside timing.\n\n## Controls and limits\n\nThe machine was busy with unrelated applications. The paired run's initial process snapshot includes ${study.hostCpuSnapshot[0].command} at ${study.hostCpuSnapshot[0].cpuCorePercent}% of one CPU core. Those applications were left running. Absolute rates drifted substantially in later cases; alternating builds and unchanged DOM/provider/no-wrap controls help detect drift but do not eliminate scheduler or thermal noise. Five samples are not a quiet-machine certification. Individual samples, iteration durations, per-case ranges and controls remain in [raw data](paired/runs.json) and [summary.csv](summary.csv). Avoid claims based on small public-API differences or overlapping ranges.\n\nThe earlier sequential [baseline](before/runs.json) and [initial row-loop candidate](row-loop/runs.json) are retained for audit, but the alternating final matrix is the primary comparison. The initial candidate prompted restoring the original direct single-row loop; its apparent short-log regression also appeared in stock DOM. Source hashes are frozen in every report; runnerSha256 identifies the common final harness when the archived baseline includes its older harness copy.\n\nSeparate 500 µs CPU sampling profiles over 128 synchronous 1 MiB parses identified upstream per-character printing and cell setters as the initial target. Diagnostic summaries are in [profiles](profiles/before.json) and [final profile](profiles/after.json). Sample percentages are not CPU utilization or wall-time speedup; minified function names are build-specific. Raw traces remain ignored locally.\n\n## Compatibility and verification\n\nOnly the captured, unchanged built-in Unicode 6 provider can use this path. Custom and Unicode 11 providers, insert mode, charset translation, accessibility output, extended/hyperlink attributes and overflowing no-wrap runs retain upstream behavior. Each wrap delegates a single character to upstream for margins, scrolling, scrollback, callbacks and isWrapped; state and provider identity are rechecked afterward. Existing wide-cell repairs remain.\n\n66 SDK tests pass, including widths 2/3/7/37/80/160, streamed wrapping/history/event parity and a provider changed by a scroll listener. Installed input differential validation passes 336 comparisons over 16,554 fragments. Browser validation passes 20 compatible integration groups and 32 visual-option groups at DPR 1/2. Native and aliased compatible npm consumers pass in development and production. SDK build, TypeScript and production demo build pass. No Rust rebuild is needed for this SDK-only change. See [validation](validation.json).\n\n## Reproduce\n\nBuild SDK and demo, serve final dist on 5196 and an immutable baseline dist on 5197. Run:\n\n\`\`\`sh\nWRAITH_BEFORE_URL=http://127.0.0.1:5197 \\\nWRAITH_BEFORE_SOURCE_ROOT=.cache/bulk-text-before \\\nWRAITH_BEFORE_HASH=6d69020d9831164032345c2590337b23bf127afe \\\nWRAITH_REPETITIONS=5 WRAITH_REPORT_DIR=docs/benchmarks/bulk-text/paired \\\nnode scripts/bulk-text-benchmark.mjs\nnode scripts/summarize-bulk-text.mjs\n\`\`\`\n\nKeep the served output and sources fixed during each run. CPU profiles use npm run profile:bulk-text separately, with no timed comparison active.\n`;
await writeFile(`${root}/REPORT.md`, await format(report, { parser: 'markdown', printWidth: 100 }));
console.log(`Validated ${study.results.length} paired records; wrote report and CSV.`);
