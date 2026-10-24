import { GhostScene } from '../demo/ghost-scene.js';
import { GhostScene as ReferenceScene } from '../.cache/gold-baseline/demo/ghost-scene.js';
import init, { Headless } from '../packages/wraith/wasm/wraith_engine.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import assert from 'node:assert/strict';
const output = process.env.WRAITH_REPORT_DIR ?? '.cache/gold-ghost';
await mkdir(output, { recursive: true });
await init({
  module_or_path: await readFile(
    new URL('../packages/wraith/wasm/wraith_engine_bg.wasm', import.meta.url),
  ),
});
const result = {
  date: new Date().toISOString(),
  cpu: cpus()[0].model,
  node: process.version,
  method:
    'Node scene generation and native Wasm parse-only CPU observations. Forty alternating pairs per grid; full cell/text equality outside timing. No GPU/display FPS claim.',
  results: [],
};
for (const [cols, rows] of [
  [120, 34],
  [192, 54],
  [240, 68],
]) {
  const scenes = [new ReferenceScene(cols, rows), new GhostScene(cols, rows)];
  const cores = [new Headless(cols, rows, 0), new Headless(cols, rows, 0)];
  const generation = [],
    parsing = [];
  let bytes,
    sgRs,
    checked = 0;
  try {
    for (let n = 0; n < 48; n++) {
      const frames = [];
      const times = [];
      for (const i of n % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now();
        frames[i] = scenes[i].frame(n / 12);
        times[i] = performance.now() - start;
      }
      if (n >= 8) generation.push({ beforeMs: times[0], afterMs: times[1] });
      for (const i of n % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now();
        cores[i].write(frames[i].bytes);
        times[i] = performance.now() - start;
      }
      if (n >= 8) parsing.push({ beforeMs: times[0], afterMs: times[1] });
      if ([0, 24, 47].includes(n)) {
        assert.equal(cores[0].text(), cores[1].text());
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < cols; x++) {
            assert.deepEqual(cores[1].cell(x, y), cores[0].cell(x, y));
            checked++;
          }
      }
      bytes = frames.map((f) => f.bytes.length);
      sgRs = frames.map((f) => f.sgrChanges);
    }
  } finally {
    for (const c of cores) c.free();
  }
  const median = (xs) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)];
  const summary = (r) => ({
    beforeMs: median(r.map((x) => x.beforeMs)),
    afterMs: median(r.map((x) => x.afterMs)),
    pairedMedianRatio: median(r.map((x) => x.beforeMs / x.afterMs)),
  });
  const row = {
    cols,
    rows,
    checkedCells: checked,
    bytes,
    sgrSequences: sgRs,
    generation: summary(generation),
    parseOnly: summary(parsing),
    raw: { generation, parsing },
  };
  result.results.push(row);
  console.log({ ...row, raw: undefined });
}
result.sources = Object.fromEntries(
  await Promise.all(
    [
      'demo/ghost-scene.js',
      'demo/ansi-frame.js',
      'demo/ghost.js',
      'scripts/ghost-performance.mjs',
    ].map(async (p) => [
      p,
      createHash('sha256')
        .update(await readFile(p))
        .digest('hex'),
    ]),
  ),
);
await writeFile(output + '/runs.json', JSON.stringify(result, null, 2) + '\n');
