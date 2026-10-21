import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Pass one or more workflow runs.json paths');
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return n ? (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2 : NaN;
};
const range = (values, digits = 0) =>
  `${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)}`;
const labels = {
  dom: 'xterm DOM',
  webgl: 'xterm WebGL',
  wraith: 'Wraith compatible',
  ghostty: 'Wraith native',
};
const table = (headers, rows) =>
  [headers, headers.map(() => '---'), ...rows].map((row) => `| ${row.join(' | ')} |`).join('\n');
const documents = [];
for (const path of paths) {
  const data = JSON.parse(await readFile(path, 'utf8'));
  const throughput = data.results.filter((r) => r.phase === 'throughput');
  const groups = new Map();
  for (const run of throughput) {
    const key = `${run.workload}/DPR${run.dpr}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const exclusions = [],
    csv = [
      'workload,dpr,type,valid,total,median_updates_per_second,min,max,cv_percent,median_parse_p95_ms,median_render_p95_ms,exclusions',
    ];
  const rows = [],
    comparisons = [];
  for (const [key, runs] of groups) {
    const reference = runs.filter((r) => r.type === 'dom').map((r) => r.textSha256);
    const unique = new Set(reference);
    if (throughput.length && unique.size !== 1)
      throw new Error(`Unstable/missing DOM reference for ${key}`);
    const measured = {},
      stable = {};
    for (const type of data.config.types) {
      const all = runs.filter((r) => r.type === type);
      const reasons = (run) =>
        [
          run.textSha256 !== reference[0] && 'text checksum mismatch',
          !run.pixelGeometryValid && 'viewport geometry mismatch',
          run.pixelCheck?.mismatches > 0 &&
            `${run.pixelCheck.mismatches}/${run.pixelCheck.checked} checked pixels differ`,
          (run.nativeUnicodeGlyphsUnverified ||
            (run.type === 'ghostty' && run.workload === 'bytewise')) &&
            'native CJK/emoji glyph coverage unverified',
        ].filter(Boolean);
      const valid = all.filter((r) => reasons(r).length === 0);
      const rejected = all.filter((r) => reasons(r).length > 0);
      for (const r of rejected)
        exclusions.push(
          `${key}, ${labels[type]}, repetition ${r.repeat + 1}: ${reasons(r).join('; ')}`,
        );
      const values = valid.map((r) => r.updatesPerSecond);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const cv =
        (Math.sqrt(values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length) / avg) * 100;
      stable[type] = cv <= 15;
      measured[type] =
        valid.length === all.length && valid.length === data.config.repetitions
          ? median(values)
          : undefined;
      csv.push(
        [
          runs[0].workload,
          runs[0].dpr,
          type,
          valid.length,
          all.length,
          valid.length ? median(values) : '',
          valid.length ? Math.min(...values) : '',
          valid.length ? Math.max(...values) : '',
          valid.length ? cv : '',
          median(valid.map((r) => r.parseMs?.p95 ?? r.parse?.p95 ?? NaN)),
          median(
            valid.map((r) => r.renderMs?.p95 ?? r.renderAndLayoutMs?.p95 ?? r.render?.p95 ?? NaN),
          ),
          JSON.stringify([...new Set(rejected.flatMap(reasons))].join('; ')),
        ].join(','),
      );
      rows.push([
        key,
        labels[type],
        `${valid.length}/${all.length}`,
        valid.length ? `${median(values).toFixed(0)} (${range(values)})` : 'excluded',
        valid.length ? `${cv.toFixed(1)}%` : '—',
      ]);
    }
    const speedup = (type) =>
      measured[type] && measured.webgl
        ? stable[type] && stable.webgl
          ? `${(measured[type] / measured.webgl).toFixed(2)}×`
          : 'noisy'
        : 'excluded';
    comparisons.push([
      key,
      ...['webgl', 'wraith', 'ghostty'].map((t) =>
        measured[t] ? measured[t].toFixed(0) + (stable[t] ? '' : '†') : 'excluded',
      ),
      speedup('wraith'),
      speedup('ghostty'),
    ]);
  }
  await writeFile(`${dirname(path)}/summary.csv`, csv.join('\n') + '\n');
  const interactions = data.results.filter((r) => r.phase === 'interaction');
  const latency = [],
    operations = [];
  for (const type of data.config.types) {
    const runs = interactions.filter((r) => r.type === type);
    if (!runs.length) continue;
    for (const load of ['idle', 'flood']) {
      const modes = runs.map((r) => r.modes.find((m) => m.load === load));
      latency.push([
        labels[type],
        load,
        ...['inputMs', 'parseAckMs', 'renderNotificationMs', 'presentationOpportunityMs'].map(
          (key) => median(modes.map((m) => m.summary[key].p95)).toFixed(2),
        ),
        load === 'flood'
          ? `${median(modes.map((m) => m.flood.acknowledged / 1048576 / (m.flood.elapsedMs / 1000))).toFixed(2)} MiB/s`
          : '—',
      ]);
    }
    operations.push([
      labels[type],
      ...['searchMs', 'selectHistoryMs', 'resizeApiMs', 'resizeCompletedMs'].map((key) =>
        median(runs.map((r) => r.operations[key].p50)).toFixed(2),
      ),
      ...[65536, 1048576].map((size) =>
        median(runs.map((r) => r.operations.pastes.find((p) => p.size === size).parsedMs)).toFixed(
          2,
        ),
      ),
    ]);
  }
  const sustained = data.results
    .filter((r) => r.phase === 'sustained')
    .map((r) => {
      const gpu = r.gpu.samples.flatMap(
        (s) => s?.devices?.map((d) => d.devicePercent).filter(Number.isFinite) ?? [],
      );
      const gpuIdle =
        r.gpu.idle?.devices?.map((d) => d.devicePercent).filter(Number.isFinite) ?? [];
      const mib = (n) => (n / 1048576).toFixed(1);
      return [
        labels[r.type],
        (r.bytes / 1048576 / (r.elapsedMs / 1000)).toFixed(2),
        (r.iterations / (r.elapsedMs / 1000)).toFixed(1),
        r.cpu.stable ? r.cpu.corePercent.toFixed(1) + '%' : 'invalid',
        r.cpu.stable ? r.cpu.machinePercent.toFixed(2) + '%' : 'invalid',
        `${mib(r.before.jsUsedBytes)} / ${mib(r.loaded.jsUsedBytes)} / ${mib(r.disposed.jsUsedBytes)}`,
        `${mib(r.before.rssBytes)} / ${mib(r.loaded.rssBytes)} / ${mib(r.disposed.rssBytes)}`,
        `${gpuIdle.length ? range(gpuIdle) : '?'} / ${gpu.length ? range(gpu) : '?'}%`,
      ];
    });
  const sections = [
    `## ${relative(process.cwd(), dirname(path))}`,
    `Source: \`${data.head}\`. ${data.cpu}, ${data.logicalCpus} logical CPUs, ${(data.memoryBytes / 1073741824).toFixed(0)} GiB RAM, ${data.os}. ${data.userAgent}. xterm ${data.xterm}, WebGL addon ${data.webglAddon}. Configured throughput grid ${data.config.cols}×${data.config.rows}, ${data.config.repetitions} repetitions. ${data.results.length} completed run sets; ${data.errors.length} harness errors.`,
    `[Raw data](${relative('docs/benchmarks/workflows', path)}) · [CSV](${relative('docs/benchmarks/workflows', dirname(path))}/summary.csv)`,
  ];
  if (comparisons.length)
    sections.push(
      '### Valid completed logical updates/s',
      'A ratio is shown only when every configured repetition passed its checks and both renderers have a coefficient of variation at most 15%. A dagger marks higher variation; inspect the detailed ranges before drawing conclusions. DOM layout timing has no GPU-completion fence and is retained separately in the detailed table. Native Unicode and bytewise fixtures contain CJK/emoji and are excluded until font coverage is certified.',
      table(
        [
          'Workload / scale',
          'xterm WebGL',
          'Compatible',
          'Native',
          'Compatible / WebGL',
          'Native / WebGL',
        ],
        comparisons,
      ),
      '<details>\n<summary>All repetitions, ranges and variability</summary>',
      table(
        ['Workload / scale', 'Renderer', 'Valid / total', 'Median (min–max) updates/s', 'CV'],
        rows,
      ),
      '</details>',
    );
  if (exclusions.length)
    sections.push('### Excluded runs', exclusions.map((s) => '- ' + s).join('\n'));
  if (latency.length)
    sections.push(
      '### Public SDK typing',
      `Median of per-run p95 values, in milliseconds. Each renderer/load has ${data.config.keys * Math.min(data.config.repetitions, 3)} actual key events. Render notification observes submission, and the following rAF observes a scheduling opportunity; neither measures scanout. Worker notifications and xterm scheduler notifications have different delivery paths.`,
      table(
        [
          'Renderer',
          'Load',
          'Key → input',
          'Parse ack',
          'Render notification',
          'Following rAF',
          'Acknowledged flood',
        ],
        latency,
      ),
      '### Public SDK operations',
      'Median of per-run medians (ms), except pastes, which have one sample per size per run. Search is cold searches of 9,000 lines. Native search/selection includes worker IPC. Native search completes a full match count, whereas this undecorated xterm findNext call may stop at the next match; the search columns are public API response times for different amounts of work. API and completed resize are separate. Completed resize includes settling and is not a CPU-only speed metric.',
      table(
        [
          'Renderer',
          'Search',
          'Select history',
          'Resize API',
          'Resize complete',
          '64 KiB paste parse',
          '1 MiB paste parse',
        ],
        operations,
      ),
    );
  if (sustained.length)
    sections.push(
      '### Eight-terminal sustained sessions',
      `One ${data.config.sustainedMs / 1000}-second observation per renderer. Target ${data.results.find((r) => r.phase === 'sustained').targetStepsPerSecond} batches/s. The harness waits for completion between batches. Compare CPU efficiency only when achieved rates match; the 30-batch/s study did not meet that condition. 100% core means one logical CPU; machine capacity divides by ${data.logicalCpus}. Heap/RSS columns show before / loaded / disposed, MiB. Main-page JS excludes worker heaps and most Wasm/GPU memory; summed RSS can count shared mappings more than once. GPU is device-wide idle / loaded range, includes other apps, and cannot be attributed to Wraith.`,
      table(
        [
          'Renderer',
          'MiB/s',
          'Batches/s',
          'CPU core',
          'CPU machine',
          'JS heap MiB',
          'Chrome RSS MiB',
          'Device GPU idle / load',
        ],
        sustained,
      ),
    );
  documents.push(sections.join('\n\n') + '\n');
}
const report = `# Expanded terminal workflow study\n\nThese are measurements of the frozen production build, not a claim of 1000 physical display frames/s. Throughput drives synchronous semantic cores with precomputed input and fences every 32 GPU submissions; the public worker SDK is measured separately. Results depend on this hardware, workload, headless Chrome scheduling and uncontrolled desktop thermals. Three repetitions identify large differences but do not establish small percentage wins. Text checks certify terminal contents, while full per-cell pixel checks are limited to Pipes. Other glyph/style coverage is not certified by a checksum.\n\n${documents.join('\n')}`;
await writeFile('docs/benchmarks/workflows/REPORT.md', report);
console.log(`Summarized ${paths.length} studies to docs/benchmarks/workflows/REPORT.md`);
