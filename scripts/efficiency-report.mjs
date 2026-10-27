// Turns docs/benchmarks/resource-efficiency/results.json into the generated tables of
// docs/benchmarks/resource-efficiency/REPORT.md (between the tables markers) and
// summary.csv. Every value is a delta over the 'none' baseline run of the same
// workload and round, and the median of the rounds is shown.
//
//   node scripts/efficiency-report.mjs [results.json]
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, 'docs/benchmarks/resource-efficiency');
const data = JSON.parse(await readFile(process.argv[2] ?? resolve(dir, 'results.json'), 'utf8'));
const MB = 2 ** 20;

const NAMES = {
  wraith: 'Wraith (native, dedicated worker)',
  'wraith-pool': 'Wraith pool (4 workers, canvas per terminal)',
  'wraith-fleet': 'Wraith Fleet (4 workers, shared surface)',
  'wraith-xterm': 'Wraith xterm-compatible (WebGPU)',
  'xterm-webgl': 'xterm.js 6 + WebGL',
  'xterm-dom': 'xterm.js 6 DOM',
  restty: 'restty',
  zem: 'zem',
  'ghostty-web': 'ghostty-web',
  wterm: 'wterm (DOM, built-in core)',
  'wterm-ghostty': 'wterm + Ghostty core',
  static: 'reference: static DOM text + CSS caret',
};
const WL = {
  idle: 'Idle, blinking cursor, 30 s',
  scroll10k: 'Idle after 10,000 lines of scrollback, 10 s',
  scroll100k: 'Idle after 100,000 lines of scrollback, 10 s',
  typing: 'Typing echo, 10 keys/s, 30 s',
  logs: 'Log stream, 200 lines/s, 20 s',
  throughput: 'Max throughput: 20 MiB colored log',
  dense: 'Full-screen truecolor redraw every frame, 160×50, 20 s',
  unicode: 'Unicode: 8 MiB of CJK, Hangul, emoji, combining marks, box drawing',
  multi16: '16 terminals × 20 lines/s each, 20 s',
  multi64: '64 terminals × 20 lines/s each, 20 s',
};

const median = (a) => {
  const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const group = (type) =>
  type === 'renderer'
    ? 'renderer'
    : type === 'GPU'
      ? 'gpu'
      : type === 'browser'
        ? 'browser'
        : 'utility';

/** Per-run raw metrics, not yet baseline-subtracted. */
function metrics(r) {
  const cpu = { renderer: 0, gpu: 0, browser: 0, utility: 0 };
  let gpuNs = 0;
  for (const [type, d] of Object.entries(r.delta.byType)) {
    cpu[group(type)] += d.cpuS * 1000;
    gpuNs += d.gpuNs;
  }
  const mem = { renderer: 0, gpu: 0, graphics: 0, total: 0, rss: 0 };
  for (const [type, m] of Object.entries(r.s1)) {
    if (type === 'renderer') mem.renderer += m.footprint;
    if (type === 'GPU') ((mem.gpu += m.footprint), (mem.graphics += m.graphics));
    mem.total += m.footprint;
    mem.rss += m.rss;
  }
  const peak = { renderer: mem.renderer, total: mem.total };
  for (const s of r.samples ?? []) {
    let rend = 0,
      tot = 0;
    for (const [type, m] of Object.entries(s.byType)) {
      if (type === 'renderer') rend += m.footprint;
      tot += m.footprint;
    }
    peak.renderer = Math.max(peak.renderer, rend);
    peak.total = Math.max(peak.total, tot);
  }
  return {
    seconds: r.delta.seconds,
    cpu: { ...cpu, total: cpu.renderer + cpu.gpu + cpu.browser + cpu.utility },
    gpuMs: gpuNs / 1e6,
    mem,
    peak,
    heap: r.heap?.before?.usedSize,
  };
}

const runs = data.runs.filter((r) => !r.gaveUp && r.delta);
const failed = data.runs.filter((r) => r.gaveUp);
const key = (r) => `${r.round}|${r.workload}`;
const base = new Map(runs.filter((r) => r.type === 'none').map((r) => [key(r), metrics(r)]));
// Baseline idle rate (ms/s) per process group, for fixed-work subtraction.
const idleBase = runs.filter((r) => r.type === 'none' && r.workload === 'idle').map(metrics);
const r0 = Object.fromEntries(
  ['renderer', 'gpu', 'browser', 'utility', 'total'].map((g) => [
    g,
    median(idleBase.map((m) => m.cpu[g] / m.seconds)),
  ]),
);
const g0 = median(idleBase.map((m) => m.gpuMs / m.seconds));

/** Baseline-subtracted values for one run. */
function delta(r) {
  const m = metrics(r);
  const b = base.get(key(r));
  if (!b) return null;
  const work = data.settings.workloads[r.workload].kind === 'work';
  const cpu = {};
  for (const g of ['renderer', 'gpu', 'browser', 'utility', 'total']) {
    cpu[g] = work
      ? m.cpu[g] - r0[g] * m.seconds - (b.cpu[g] - r0[g] * b.seconds) // CPU-ms for the work
      : m.cpu[g] / m.seconds - b.cpu[g] / b.seconds; // CPU-ms per second
  }
  const gpuMs = work
    ? m.gpuMs - g0 * m.seconds - (b.gpuMs - g0 * b.seconds)
    : m.gpuMs / m.seconds - b.gpuMs / b.seconds;
  const memD = {
    renderer: (m.mem.renderer - b.mem.renderer) / MB,
    gpu: (m.mem.gpu - b.mem.gpu) / MB,
    graphics: (m.mem.graphics - b.mem.graphics) / MB,
    total: (m.mem.total - b.mem.total) / MB,
    rss: (m.mem.rss - b.mem.rss) / MB,
    peakRenderer: (m.peak.renderer - b.peak.renderer) / MB,
    peakTotal: (m.peak.total - b.peak.total) / MB,
    heap: (m.heap - b.heap) / MB,
  };
  const p = r.phase ?? {};
  const updatesPerS = p.delivered / (p.elapsedMs / 1000);
  return {
    cpu,
    gpuMs,
    mem: memD,
    updatesPerS,
    skipped: p.skipped,
    delivered: p.delivered,
    elapsedS: p.elapsedMs / 1000,
    bytes: r.setup?.corpus?.bytes,
    lost: p.lostContexts,
    marker: r.check?.marker,
    retained: r.check?.retained,
    load: r.loadBefore?.[0],
    quiet: r.gate?.loadGateMet,
  };
}

const order = [
  'wraith',
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
  'static',
];
const agg = {}; // agg[workload][type] = medians
for (const wl of Object.keys(WL)) {
  agg[wl] = {};
  for (const type of order) {
    const ds = runs
      .filter((r) => r.workload === wl && r.type === type)
      .map(delta)
      .filter(Boolean);
    if (!ds.length) continue;
    const pick = (f) => median(ds.map(f));
    agg[wl][type] = {
      n: ds.length,
      cpu: Object.fromEntries(Object.keys(ds[0].cpu).map((g) => [g, pick((d) => d.cpu[g])])),
      cpuMin: Math.min(...ds.map((d) => d.cpu.total)),
      cpuMax: Math.max(...ds.map((d) => d.cpu.total)),
      gpuMs: pick((d) => d.gpuMs),
      mem: Object.fromEntries(Object.keys(ds[0].mem).map((g) => [g, pick((d) => d.mem[g])])),
      updatesPerS: pick((d) => d.updatesPerS),
      skipped: pick((d) => d.skipped),
      elapsedS: pick((d) => d.elapsedS),
      bytes: ds[0].bytes,
      lost: Math.max(...ds.map((d) => d.lost ?? 0)),
      marker: ds.map((d) => d.marker),
      retained: pick((d) => d.retained),
      load: pick((d) => d.load),
      quiet: ds.filter((d) => d.quiet).length,
    };
  }
}

const f0 = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '–');
const f1 = (x) =>
  Number.isFinite(x)
    ? Math.abs(x) < 10
      ? x.toFixed(1)
      : Math.round(x).toLocaleString('en-US')
    : '–';
const mk = (m) =>
  m.every((x) => x === true)
    ? 'yes'
    : m.every((x) => x == null)
      ? 'n/a'
      : `${m.filter((x) => x === true).length}/${m.length}`;
const lines = [];
const table = (head, rows) => {
  lines.push(`| ${head.join(' | ')} |`, `|${head.map((h, i) => (i ? '---:' : '---')).join('|')}|`);
  for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
  lines.push('');
};

lines.push(
  `Generated by \`scripts/efficiency-report.mjs\` from \`results.json\` (${data.runs.length} runs, ${failed.length} did not complete). Medians of ${data.settings.rounds} rounds; each value is the renderer's run minus the no-terminal baseline run of the same workload and round. CPU = CPU-ms summed over every Chrome process (renderer incl. workers, GPU, browser, utility). RAM = macOS phys_footprint at the end of the window. GPU time = Apple GPU time accumulated by Chrome's processes.`,
  '',
);

for (const [wl, title] of Object.entries(WL)) {
  const rows = agg[wl];
  if (!rows || !Object.keys(rows).length) continue;
  const work = data.settings.workloads[wl].kind === 'work';
  lines.push(`### ${title}`, '');
  if (work) {
    const bytes = Object.values(rows)[0].bytes;
    table(
      [
        'Renderer',
        'CPU-ms / MiB',
        'renderer',
        'GPU proc',
        'browser',
        'Time to finish s',
        'MiB/s',
        'GPU-ms / MiB',
        'Renderer RAM Δ MiB (peak)',
        'GPU-proc RAM Δ MiB',
        'Total RAM Δ MiB (peak)',
        'Text check',
      ],
      Object.entries(rows).map(([t, a]) => [
        NAMES[t],
        f1(a.cpu.total / (bytes / MB)),
        f1(a.cpu.renderer / (bytes / MB)),
        f1(a.cpu.gpu / (bytes / MB)),
        f1(a.cpu.browser / (bytes / MB)),
        a.elapsedS.toFixed(2),
        f1(bytes / MB / a.elapsedS),
        f1(a.gpuMs / (bytes / MB)),
        f0(a.mem.peakRenderer),
        f0(a.mem.gpu),
        f0(a.mem.peakTotal),
        mk(a.marker),
      ]),
    );
  } else {
    const paced = !['idle', 'scroll10k', 'scroll100k'].includes(wl);
    const scroll = wl.startsWith('scroll');
    const head = [
      'Renderer',
      'CPU-ms/s',
      'range',
      'renderer',
      'GPU proc',
      'browser',
      'GPU-ms/s',
      'Renderer RAM Δ MiB',
      'GPU-proc RAM Δ MiB (graphics)',
      'Total RAM Δ MiB',
    ];
    if (paced) head.push('Updates/s', 'Skipped', 'CPU-ms / 1k updates');
    if (scroll) head.push('Retained lines');
    if (wl.startsWith('multi')) head.push('RAM Δ / terminal MiB', 'Lost contexts');
    head.push('Text check');
    table(
      head,
      Object.entries(rows).map(([t, a]) => {
        const row = [
          NAMES[t],
          f1(a.cpu.total),
          `${f0(a.cpuMin)}–${f0(a.cpuMax)}`,
          f1(a.cpu.renderer),
          f1(a.cpu.gpu),
          f1(a.cpu.browser),
          f1(a.gpuMs),
          f0(a.mem.renderer),
          `${f0(a.mem.gpu)} (${f0(a.mem.graphics)})`,
          f0(a.mem.total),
        ];
        if (paced)
          row.push(f1(a.updatesPerS), f0(a.skipped), f1((a.cpu.total / a.updatesPerS) * 1000));
        if (scroll) row.push(Number.isFinite(a.retained) ? f0(a.retained) : 'not exposed');
        if (wl.startsWith('multi'))
          row.push(
            f1(
              a.mem.total / data.settings.workloads[wl].terminals ||
                a.mem.total / Number(wl.slice(5)),
            ),
            String(a.lost),
          );
        row.push(mk(a.marker));
        return row;
      }),
    );
  }
}

// ---------------------------------------------------------------- summary
const summary = {};
for (const t of order.filter((t) => t !== 'static')) {
  const g = (wl) => agg[wl]?.[t];
  const perMB = (wl) => (g(wl) ? g(wl).cpu.total / (g(wl).bytes / MB) : NaN);
  const multiType = t === 'wraith' ? 'wraith-pool' : t;
  summary[t] = {
    idleCpu: g('idle')?.cpu.total,
    typingCpu: g('typing')?.cpu.total,
    logsCpu: g('logs')?.cpu.total,
    throughputCpuPerMB: perMB('throughput'),
    unicodeCpuPerMB: perMB('unicode'),
    denseCpuPer1k: g('dense') ? (g('dense').cpu.total / g('dense').updatesPerS) * 1000 : NaN,
    denseUpdatesPerS: g('dense')?.updatesPerS,
    multi16Cpu: agg.multi16?.[multiType]?.cpu.total,
    multi64Cpu: agg.multi64?.[multiType]?.cpu.total,
    idleRam: g('idle')?.mem.total,
    idleRendererRam: g('idle')?.mem.renderer,
    idleGpuRam: g('idle')?.mem.gpu,
    ramPer10kLines:
      g('scroll100k') && g('idle')
        ? (g('scroll100k').mem.renderer - g('idle').mem.renderer) / 10
        : NaN,
    retained100k: g('scroll100k')?.retained,
    ramPerTerminal64: agg.multi64?.[multiType] ? agg.multi64[multiType].mem.total / 64 : NaN,
  };
}
summary['wraith-fleet'] = {
  ...Object.fromEntries(Object.keys(summary.wraith ?? {}).map((k) => [k, NaN])),
  multi16Cpu: agg.multi16?.['wraith-fleet']?.cpu.total,
  multi64Cpu: agg.multi64?.['wraith-fleet']?.cpu.total,
  ramPerTerminal64: agg.multi64?.['wraith-fleet']
    ? agg.multi64['wraith-fleet'].mem.total / 64
    : NaN,
};
delete summary['wraith-pool'];

lines.push('### Efficiency summary', '');
lines.push(
  'Single-terminal columns use the dedicated-worker Wraith; the multi-terminal columns of the Wraith row use the per-canvas pool, and Fleet has its own row. RAM per 10k lines = (renderer-process footprint after 100k lines − idle) / 10, meaningful only where the renderer retains the lines (see the retained column).',
  '',
);
table(
  [
    'Renderer',
    'Idle CPU-ms/s',
    'Typing CPU-ms/s',
    'Logs CPU-ms/s',
    'CPU-ms / MiB (log)',
    'CPU-ms / MiB (Unicode)',
    'CPU-ms / 1k full redraws',
    '16 term CPU-ms/s',
    '64 term CPU-ms/s',
    'Idle RAM Δ MiB (renderer + GPU)',
    'RAM / 10k lines MiB',
    'Retained of 100k',
    'RAM / terminal (64) MiB',
  ],
  Object.entries(summary).map(([t, s]) => [
    NAMES[t],
    f1(s.idleCpu),
    f1(s.typingCpu),
    f1(s.logsCpu),
    f1(s.throughputCpuPerMB),
    f1(s.unicodeCpuPerMB),
    f1(s.denseCpuPer1k),
    f1(s.multi16Cpu),
    f1(s.multi64Cpu),
    Number.isFinite(s.idleRam)
      ? `${f0(s.idleRam)} (${f0(s.idleRendererRam)} + ${f0(s.idleGpuRam)})`
      : '–',
    f1(s.ramPer10kLines),
    Number.isFinite(s.retained100k) ? f0(s.retained100k) : 'not exposed',
    f1(s.ramPerTerminal64),
  ]),
);

// Ranking: geometric mean, over the CPU metrics a renderer has, of its value
// relative to the best renderer on that metric (1.00 = best everywhere).
function rank(metricsList) {
  const out = [];
  for (const [t, s] of Object.entries(summary)) {
    const rel = [];
    for (const k of metricsList) {
      const vals = Object.values(summary)
        .map((x) => x[k])
        .filter((x) => Number.isFinite(x) && x > 0);
      if (Number.isFinite(s[k]) && vals.length) rel.push(Math.max(s[k], 1e-3) / Math.min(...vals));
    }
    if (rel.length === metricsList.length)
      out.push([t, Math.exp(rel.reduce((a, x) => a + Math.log(x), 0) / rel.length)]);
  }
  return out.sort((a, b) => a[1] - b[1]);
}
const cpuKeys = [
  'idleCpu',
  'typingCpu',
  'logsCpu',
  'throughputCpuPerMB',
  'unicodeCpuPerMB',
  'denseCpuPer1k',
  'multi16Cpu',
  'multi64Cpu',
];
const ramKeys = ['idleRam', 'ramPerTerminal64'];
lines.push('### Efficiency ranking', '');
lines.push(
  `CPU: geometric mean over ${cpuKeys.length} CPU metrics (idle, typing, logs, CPU/MiB log, CPU/MiB Unicode, CPU/1k redraws, 16 and 64 terminals) of each renderer's value divided by the best renderer's. RAM: same over idle total RAM Δ and RAM per terminal at 64. 1.00 = best on every metric. Fleet is excluded (multi-terminal only).`,
  '',
);
const rc = rank(cpuKeys),
  rr = rank(ramKeys);
table(
  ['#', 'CPU', 'relative', 'RAM', 'relative'],
  rc.map((x, i) => [
    String(i + 1),
    NAMES[x[0]],
    x[1].toFixed(2),
    rr[i] ? NAMES[rr[i][0]] : '',
    rr[i] ? rr[i][1].toFixed(2) : '',
  ]),
);

if (failed.length) {
  lines.push('### Runs that did not complete', '');
  table(
    ['Round', 'Workload', 'Renderer', 'Reason'],
    failed.map((r) => [
      String(r.round),
      r.workload,
      NAMES[r.type] ?? r.type,
      `${r.gaveUp}${r.errors?.length ? ': ' + r.errors[0].replace(/\|/g, '/') : ''}`,
    ]),
  );
}
const loads = data.runs.map((r) => r.loadBefore?.[0]).filter(Number.isFinite);
lines.push(
  `Machine load (1-min) before runs: median ${median(loads).toFixed(1)}, max ${Math.max(...loads).toFixed(1)}; ${data.runs.filter((r) => r.gate?.loadGateMet).length}/${data.runs.length} runs started under the load gate of ${data.settings.maxLoad}.`,
  '',
);

const report = resolve(dir, 'REPORT.md');
let text = await readFile(report, 'utf8').catch(
  () => '<!-- tables:start -->\n<!-- tables:end -->\n',
);
text = text.replace(
  /<!-- tables:start -->[\s\S]*<!-- tables:end -->/,
  `<!-- tables:start -->\n\n${lines.join('\n')}\n<!-- tables:end -->`,
);
await writeFile(report, text);
const csv = [['renderer', ...Object.keys(summary.wraith)].join(',')];
for (const [t, s] of Object.entries(summary))
  csv.push(
    [t, ...Object.values(s).map((v) => (Number.isFinite(v) ? +v.toFixed(2) : ''))].join(','),
  );
await writeFile(resolve(dir, 'summary.csv'), csv.join('\n') + '\n');
console.log(`wrote ${report} and summary.csv`);
