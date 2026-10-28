// Seek latency of the replay player on a 10-minute, multi-megabyte session.
// Compares verified keyframes against replay-from-start, for random seeks and
// for a scrub sweep. Requires the demo server.
//   WRAITH_URL=http://127.0.0.1:5173 npm run benchmark:replay
// Writes docs/benchmarks/replay/seek.json (override with WRAITH_REPORT_DIR).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const out = process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/replay';
const headless = process.env.HEADED !== '1';
const repetitions = Number(process.env.WRAITH_REPETITIONS ?? 3);
const seeks = Number(process.env.WRAITH_SEEKS ?? 200);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless,
  args: ['--enable-unsafe-webgpu'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/replay.html`);
  await page.waitForFunction(() => window.replayLab?.player());
  await page.evaluate(() => window.replayLab.ready());
  await page.evaluate(() => window.replayLab.player()?.dispose());
  const workload = await page.evaluate(() => {
    const recording = window.replayLab.longSession();
    window.benchRecording = recording;
    let bytes = 0;
    const counts = {};
    for (const event of recording.events) {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      if (event.type === 'output') bytes += event.data.byteLength;
    }
    return {
      generator:
        'scripts/replay-fixture.mjs generateSession({ seconds: 600, seed: 42, cols: 120, rows: 36, scale: 1.5 })',
      duration: recording.duration,
      outputBytes: bytes,
      events: counts,
      cols: recording.cols,
      rows: recording.rows,
      adapter: '',
    };
  });
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    // Alternate configuration order between repetitions.
    const order = repetition % 2 ? [false, true] : [true, false];
    for (const keyframes of order) {
      const run = await page.evaluate(
        async ({ keyframes, seeks, repetition }) => {
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;left:0;top:0;width:1400px;z-index:10';
          document.body.append(host);
          const mountStart = performance.now();
          const player = await window.replayLab.Wraith.player(host, window.benchRecording, {
            keyframes,
            controls: true,
            fontSize: 12,
          });
          const mountMs = performance.now() - mountStart;
          let stats = null;
          if (keyframes)
            stats = await (player.keyframeStats
              ? Promise.resolve(player.keyframeStats)
              : new Promise((resolve) => player.onKeyframes(resolve)));
          const duration = player.duration;
          let seed = 1000 + repetition;
          const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
          const measure = async (times) => {
            const samples = [];
            for (const time of times) {
              const started = performance.now();
              await player.seek(time);
              const parsed = performance.now() - started;
              const result = player.lastSeek;
              await player.terminal.flush();
              const fenced = performance.now() - started;
              samples.push({
                time,
                parsedMs: parsed,
                fencedMs: fenced,
                restored: result.restored,
                keyframe: result.keyframe,
                bytes: result.bytes,
              });
            }
            return samples;
          };
          // Warm up JIT and GPU pipelines.
          await measure(Array.from({ length: 10 }, () => random() * duration));
          const randomTimes = Array.from({ length: seeks }, () => random() * duration);
          const sweep = [];
          // A scrub drag: 0.5% steps forward across the recording, then back.
          for (let f = 0.2; f <= 0.7 + 1e-9; f += 0.005) sweep.push(f * duration);
          for (let f = 0.7; f >= 0.2 - 1e-9; f -= 0.005) sweep.push(f * duration);
          const result = {
            repetition,
            keyframes,
            mountMs,
            keyframeStats: stats,
            keyframeCount: player.keyframeCount,
            adapter: '',
            random: await measure(randomTimes),
            scrub: await measure(sweep),
          };
          await player.dispose();
          host.remove();
          return result;
        },
        { keyframes, seeks, repetition },
      );
      runs.push(run);
      const p = (list, key, q) => {
        const values = list.map((s) => s[key]).sort((a, b) => a - b);
        return values[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)];
      };
      console.log(
        `rep ${repetition} keyframes=${keyframes}: random parsed p50 ${p(run.random, 'parsedMs', 0.5).toFixed(2)} p95 ${p(run.random, 'parsedMs', 0.95).toFixed(2)} | fenced p50 ${p(run.random, 'fencedMs', 0.5).toFixed(2)} p95 ${p(run.random, 'fencedMs', 0.95).toFixed(2)} | scrub parsed p95 ${p(run.scrub, 'parsedMs', 0.95).toFixed(2)}`,
      );
    }
  }
  const adapter = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    const info = adapter?.info;
    return info ? `${info.vendor} ${info.architecture} ${info.description}`.trim() : 'unknown';
  });
  workload.adapter = adapter;
  let macos = '';
  try {
    macos = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
  } catch {
    macos = os.release();
  }
  const report = {
    date: new Date().toISOString(),
    build: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0 },
    environment: {
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      platform: `${os.platform()} ${macos}`,
      chrome: browser.version(),
      headless,
      userAgent: await page.evaluate(() => navigator.userAgent),
      adapter,
    },
    method:
      'Each seek: player.seek(t) resolves when the terminal has parsed the bytes (parsedMs); terminal.flush() then waits for a render and its GPU fence (fencedMs, measured from the seek start). Display presentation is not measured. 10 warm-up seeks per run.',
    workload,
    runs,
    errors,
  };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'seek.json'), JSON.stringify(report, null, 1) + '\n');
  console.log(`wrote ${join(out, 'seek.json')}`);
} finally {
  await browser.close();
}
