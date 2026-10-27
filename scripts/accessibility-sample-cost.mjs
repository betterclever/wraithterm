// Per-sample CPU cost of screen reader mode in isolation (Node, headless engine):
// one viewport text read, row split, scroll alignment, announcement diff and
// mirror patch, after each block of new output. Run after `npm run build:sdk`.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import init, { Headless } from '../packages/wraith/wasm/wraith_engine.js';
import { OutputAnnouncer, mirrorPatch, splitRows } from '../packages/wraith/dist/announcer.js';
await init({
  module_or_path: await readFile(
    new URL('../packages/wraith/wasm/wraith_engine_bg.wasm', import.meta.url),
  ),
});
const output = process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/accessibility';
const encoder = new TextEncoder();
const percentile = (values, p) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)];
};
const results = [];
for (const [cols, rows] of [
  [80, 24],
  [160, 50],
  [300, 100],
]) {
  for (const linesPerSample of [1, 10, rows]) {
    const t = new Headless(cols, rows, 10000);
    const announcer = new OutputAnnouncer();
    let mirrored = [];
    let line = 0;
    const block = () => {
      let s = '';
      for (let i = 0; i < linesPerSample; i++)
        s += `\x1b[32m${String(line++).padStart(8, '0')}\x1b[0m ${'log '.repeat(cols / 4 - 3)}\r\n`;
      return encoder.encode(s);
    };
    const samples = [];
    let now = 0;
    for (let i = 0; i < 600; i++) {
      t.write(block());
      const start = performance.now();
      const text = t.text();
      const split = splitRows(text, rows);
      announcer.sample(split, (now += 100));
      announcer.flush(now);
      const patch = mirrorPatch(mirrored, split);
      mirrored = split;
      const ms = performance.now() - start;
      if (i >= 100) samples.push(ms);
      if (patch.length < 0) throw new Error('unreachable');
    }
    t.free();
    results.push({
      cols,
      rows,
      linesPerSample,
      samples: samples.length,
      p50Us: percentile(samples, 0.5) * 1000,
      p95Us: percentile(samples, 0.95) * 1000,
      maxUs: Math.max(...samples) * 1000,
    });
  }
}
const report = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version,
  hardware: {
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    os: `${process.platform} ${release()}`,
  },
  methodology:
    'Node, Wasm Headless engine. Each sample: write N new lines, then time Headless.text() (snapshot update + viewport text) + splitRows + OutputAnnouncer.sample/flush + mirrorPatch, the work one 100 ms worker sample does. The first 100 samples are warmup. In the browser this runs at most every 100 ms while output changes, in the worker, not on the main thread; DOM work (changed rows, one live-region node) is not included.',
  results,
};
console.table(results);
await mkdir(output, { recursive: true });
await writeFile(`${output}/sample-cost.json`, JSON.stringify(report, null, 2) + '\n');
