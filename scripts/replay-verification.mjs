// Keyframe verification density check in Node: build keyframes for the
// benchmark session with the default sampled verification and with a digest
// comparison after every event, and record both.
//   npm run build:sdk && node scripts/replay-verification.mjs [out.json]
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const root = new URL('..', import.meta.url);
const engine = await import(new URL('packages/wraith/wasm/wraith_engine.js', root));
await engine.default({
  module_or_path: await readFile(new URL('packages/wraith/wasm/wraith_engine_bg.wasm', root)),
});
const { Timeline, buildKeyframes } = await import(new URL('packages/wraith/dist/replay.js', root));
const { parseAsciicast } = await import(new URL('packages/wraith/dist/recording.js', root));
const { generateSession } = await import(new URL('scripts/replay-fixture.mjs', root));
const sessions = {
  'benchmark session (seed 42, 600 s, 120x36, scale 1.5)': generateSession({
    seconds: 600,
    seed: 42,
    cols: 120,
    rows: 36,
    scale: 1.5,
  }),
  'fixture (seed 7, 300 s, 80x24)': generateSession({ seconds: 300, seed: 7, cols: 80, rows: 24 }),
  'demo/replay/sample.cast': parseAsciicast(
    await readFile(new URL('demo/replay/sample.cast', root), 'utf8'),
  ),
};
const results = [];
for (const [name, recording] of Object.entries(sessions)) {
  const timeline = Timeline.from(recording);
  for (const [mode, options] of [
    ['sampled (default)', { history: 1000 }],
    ['every event', { history: 1000, sampleEvery: 1 }],
    ['sampled, 32 KiB interval', { history: 1000, interval: 32768 }],
    ['every event, 32 KiB interval', { history: 1000, interval: 32768, sampleEvery: 1 }],
  ]) {
    const stats = buildKeyframes(
      timeline,
      (cols, rows, history) => new engine.Headless(cols, rows, history),
      options,
      () => {},
    );
    results.push({ session: name, outputBytes: timeline.bytes.byteLength, mode, stats });
    console.log(name, mode, JSON.stringify(stats));
  }
}
const out = process.argv[2] ?? 'docs/benchmarks/replay/verification.json';
await writeFile(
  out,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      build: {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).length > 0,
      },
      environment: { cpu: os.cpus()[0]?.model, node: process.version, platform: os.platform() },
      note: 'elapsedMs is single-threaded Node time for the whole build, not browser worker time.',
      results,
    },
    null,
    1,
  ) + '\n',
);
console.log(`wrote ${out}`);
