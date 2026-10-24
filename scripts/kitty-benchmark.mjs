// Kitty graphics throughput: stream animated frames that fill the whole grid,
// each a fresh transmit-and-display of new pixels under one image id, and wait
// for GPU completion after every frame (flush() resolves after the render's
// fence). Frames are generated and encoded in the page before timing.
// Run alone: no captures, renders or other benchmarks alongside.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const url = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173/playground.html';
const out = resolve(root, process.env.OUT ?? 'docs/benchmarks/kitty');
const workloads = [
  { name: 'rgba-640x360', width: 640, height: 360, format: 'rgba' },
  { name: 'rgba-1280x720', width: 1280, height: 720, format: 'rgba' },
  { name: 'png-640x360', width: 640, height: 360, format: 'png' },
  { name: 'png-1280x720', width: 1280, height: 720, format: 'png' },
];
const rounds = Number(process.env.ROUNDS ?? 3),
  warm = 30,
  measured = Number(process.env.FRAMES ?? 180),
  distinct = 24;

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
});
const runs = [];
let userAgent, adapter;
try {
  for (let round = 0; round < rounds; round++)
    for (const workload of round % 2 ? [...workloads].reverse() : workloads) {
      const page = await browser.newPage({
        viewport: { width: 1400, height: 1000 },
        deviceScaleFactor: 1,
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url);
      await page.waitForFunction(() => window.wraith);
      const result = await page.evaluate(
        async ({ workload, warm, measured, distinct }) => {
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;inset:0;z-index:10000';
          document.body.append(host);
          const term = await window.wraith.constructor.mount(host, {
            cols: 160,
            rows: 45,
            fit: false,
          });
          const adapter = await new Promise((done) => {
            const listener = term.onStats((s) => {
              listener.dispose();
              done(s.adapter);
            });
          });
          const { width: w, height: h } = workload;
          // A moving plasma: every pixel changes every frame.
          const frames = [];
          const canvas = new OffscreenCanvas(w, h),
            context = canvas.getContext('2d');
          for (let f = 0; f < distinct; f++) {
            const pixels = new Uint8ClampedArray(w * h * 4);
            for (let y = 0, i = 0; y < h; y++)
              for (let x = 0; x < w; x++, i += 4) {
                const v =
                  Math.sin(x / 37 + f / 3) + Math.sin(y / 23 - f / 5) + Math.sin((x + y) / 53);
                pixels[i] = 128 + 127 * Math.sin(v * 2);
                pixels[i + 1] = 128 + 127 * Math.sin(v * 2 + 2);
                pixels[i + 2] = 128 + 127 * Math.sin(v * 2 + 4);
                pixels[i + 3] = 255;
              }
            let payload, control;
            if (workload.format === 'png') {
              context.putImageData(new ImageData(pixels, w, h), 0, 0);
              const blob = await canvas.convertToBlob({ type: 'image/png' });
              payload = new Uint8Array(await blob.arrayBuffer()).toBase64();
              control = 'f=100';
            } else {
              payload = new Uint8Array(pixels.buffer).toBase64();
              control = `f=32,s=${w},v=${h}`;
            }
            // Chunk as real clients do (4096 base64 bytes per escape).
            let text = '\x1b[H';
            for (let i = 0; i < payload.length; i += 4096) {
              const more = i + 4096 < payload.length ? 1 : 0;
              const head = i ? `m=${more}` : `a=T,${control},i=1,q=2,c=160,r=45,C=1,m=${more}`;
              text += `\x1b_G${head};${payload.slice(i, i + 4096)}\x1b\\`;
            }
            frames.push(new TextEncoder().encode(text));
          }
          const payloadBytes = frames.reduce((a, f) => a + f.length, 0) / frames.length;
          const samples = [];
          for (let i = 0; i < warm + measured; i++) {
            const started = performance.now();
            await term.write(frames[i % distinct]);
            await term.flush();
            if (i >= warm) samples.push(performance.now() - started);
          }
          const text = await term.getText();
          await term.dispose();
          return { adapter, payloadBytes, samples, blankText: text.trim() === '' };
        },
        { workload, warm, measured, distinct },
      );
      userAgent ??= await page.evaluate(() => navigator.userAgent);
      adapter ??= result.adapter;
      if (errors.length) throw new Error(errors.join('; '));
      if (!result.blankText) throw new Error('image payload leaked into terminal text');
      const total = result.samples.reduce((a, b) => a + b, 0);
      const sorted = [...result.samples].sort((a, b) => a - b);
      const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      const run = {
        round,
        workload: workload.name,
        framesPerSecond: (result.samples.length / total) * 1000,
        payloadMiBPerSecond:
          (result.payloadBytes * result.samples.length) / (total / 1000) / 2 ** 20,
        payloadBytesPerFrame: Math.round(result.payloadBytes),
        p50Ms: p(0.5),
        p95Ms: p(0.95),
        samples: result.samples.map((s) => +s.toFixed(3)),
      };
      runs.push(run);
      console.log(
        `${round} ${workload.name}: ${run.framesPerSecond.toFixed(1)} GPU-completed frames/s, ${run.payloadMiBPerSecond.toFixed(0)} MiB/s payload, p50 ${run.p50Ms.toFixed(2)} ms, p95 ${run.p95Ms.toFixed(2)} ms`,
      );
      await page.close();
    }
} finally {
  await browser.close();
}
const sha = async (f) =>
  createHash('sha256')
    .update(await readFile(resolve(root, f)))
    .digest('hex');
const summary = Object.fromEntries(
  workloads.map(({ name }) => {
    const fps = runs.filter((r) => r.workload === name).map((r) => r.framesPerSecond);
    return [name, { slowestFps: Math.min(...fps), fastestFps: Math.max(...fps) }];
  }),
);
await mkdir(out, { recursive: true });
await writeFile(
  resolve(out, 'results.json'),
  JSON.stringify(
    {
      measured: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      sources: Object.fromEntries(
        await Promise.all(
          [
            'packages/wraith/wasm/wraith_engine_bg.wasm',
            'packages/wraith/src/worker.ts',
            'scripts/kitty-benchmark.mjs',
          ].map(async (f) => [f, await sha(f)]),
        ),
      ),
      browser: userAgent,
      adapter,
      cpu: cpus()[0]?.model,
      method: {
        grid: '160x45 at DPR 1; each frame scaled to the whole grid (c=160,r=45)',
        frame: 'a=T under one image id, q=2, base64 chunked at 4,096 bytes; every pixel changes',
        timing: 'write() then flush(), which waits for the frame and its GPU fence; sequential',
        warm,
        measured,
        distinct,
        rounds,
        note: 'GPU-completed frames per second; not physical display FPS',
      },
      summary,
      runs,
    },
    null,
    2,
  ) + '\n',
);
console.log(summary);
