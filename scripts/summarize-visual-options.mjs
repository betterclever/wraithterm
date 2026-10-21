import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = 'docs/benchmarks/gpu-visual-options';
const data = JSON.parse(await readFile(process.argv[2] ?? root + '/final/runs.json', 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [file, expected] of Object.entries(data.sources))
  assert.equal(hash(await readFile(file)), expected, file + ' changed');
assert.equal(
  hash(execFileSync('git', ['show', data.beforeHead + ':packages/wraith/src/xterm-renderer.ts'])),
  data.beforeRendererSha256,
);
assert.equal(
  hash(
    execFileSync('git', ['show', data.beforeHead + ':packages/wraith/wasm/wraith_engine_bg.wasm'], {
      maxBuffer: 8 * 1024 * 1024,
    }),
  ),
  data.beforeEngineSha256,
);
assert.equal(data.results.length, 24 * data.repetitions);
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2;
};
const range = (values) => `${Math.min(...values).toFixed(0)}–${Math.max(...values).toFixed(0)}`;
const cv = (values) => {
  const mean = values.reduce((a, b) => a + b) / values.length;
  return (Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) / mean) * 100;
};
const rows = [],
  csv = [
    'mode,workload,before_renderer,after_renderer,before_median,after_median,ratio,before_min,before_max,after_min,after_max,before_cv_percent,after_cv_percent',
  ];
for (const mode of ['plain', 'contrast', 'transparency', 'both'])
  for (const workload of ['dense', 'scroll', 'sparse']) {
    const runs = data.results.filter((r) => r.mode === mode && r.workload === workload);
    assert.equal(new Set(runs.map((r) => r.textSha256)).size, 1, mode + '/' + workload + ' text');
    const values = (build) => runs.filter((r) => r.build === build).map((r) => r.updatesPerSecond);
    const before = values('before'),
      after = values('after');
    assert.equal(before.length, data.repetitions);
    assert.equal(after.length, data.repetitions);
    for (const r of runs)
      assert.equal(r.renderer, r.build === 'after' || mode === 'plain' ? 'webgpu' : 'dom');
    const ratio = median(after) / median(before),
      uncertain = cv(before) > 15 || cv(after) > 15;
    rows.push([
      mode,
      workload,
      median(before).toFixed(0),
      median(after).toFixed(0),
      ratio.toFixed(2) + '×' + (uncertain ? '†' : ''),
      range(before),
      range(after),
    ]);
    csv.push(
      [
        mode,
        workload,
        mode === 'plain' ? 'webgpu' : 'dom',
        'webgpu',
        median(before),
        median(after),
        ratio,
        Math.min(...before),
        Math.max(...before),
        Math.min(...after),
        Math.max(...after),
        cv(before),
        cv(after),
      ].join(','),
    );
  }
const table = [
  ['Mode', 'Workload', 'Before', 'After', 'Ratio', 'Before range', 'After range'],
  Array(7).fill('---'),
  ...rows,
]
  .map((r) => '| ' + r.join(' | ') + ' |')
  .join('\n');
const report = `# GPU visual-option throughput

The compatible renderer now keeps transparency and minimum contrast on WebGPU. The optional pass reads guarded packed row words, falls back to public getters for extended/combined/unfamiliar cells, and only processes newly packed rows. Per-color alpha fits the existing 20-byte cells; default opaque cells retain the original interpretation.

Before: \`${data.beforeHead}\` (scrolling fix included, visual options use DOM). After: \`${data.head}\`. ${data.cpu}, ${data.logicalCpus} logical CPUs; ${data.userAgent}. 160×50, monospace 15px, DPR1, ${data.repetitions} repetitions, ${data.results.length} completed run sets. Exact source and Wasm hashes are in [the raw data](final/runs.json).

Rates below are **completed logical updates/s**, with medians and min–max ranges. Plain mode uses GPU completion fences on both builds. Other modes compare the previous DOM fallback (forced layout, no GPU-completion fence) with the new GPU path (fenced every 32 submissions). These are not physical display FPS or identical completion guarantees. Each run warms 32 precomputed variants, then measures at least one second and 512 updates. Contrast uses ratio 7; transparency uses a 50% theme background. A dagger marks a coefficient of variation above 15% in either cohort.

${table}

The 32 DPR1/DPR2 [visual checks](../../compatibility/gpu-visual-options.json) verify actual alpha pixels over a colored parent, opaque cursor/truecolor backgrounds, contrast against upstream, dim/block policy, live changes, retained rows, selection/decoration/hover precedence, atlas reset, joiner fallback and forced renderer failure. The complete optional-pass output is also compared with forced getter storage for palette/inverse/bold, wide and combined cells. All timed fixed-count text replays match. These checks do not certify every glyph/style combination.

This is a warm repeated-variant study, not a cold font load or adversarial unique-color stream. Three repetitions and uncontrolled desktop thermals do not establish small percentage changes in default mode. The earlier [broader study](../workflows/REPORT.md) records CPU/device-wide GPU activity for its own frozen build. An earlier [prototype matrix](prototype/runs.json) is retained with its own source commit; absolute rates across sessions should not be used as a speedup claim.

Reproduce using immutable production previews. These paths identify this local baseline archive; replace them with your frozen checkout when running elsewhere:

\`\`\`sh
WRAITH_BEFORE_HASH=ded1ef1 WRAITH_BEFORE_SOURCE_ROOT=/private/tmp/wraith-selection-clean WRAITH_BEFORE_WASM=/private/tmp/wraith-selection-clean/packages/wraith/wasm WRAITH_BEFORE_URL=http://127.0.0.1:5198 WRAITH_URL=http://127.0.0.1:5196 npm run benchmark:visual-options
node scripts/summarize-visual-options.mjs
\`\`\`
`;
await writeFile(root + '/summary.csv', csv.join('\n') + '\n');
await writeFile(root + '/REPORT.md', report);
console.log('Validated and summarized ' + data.results.length + ' visual-option run sets');
