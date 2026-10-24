import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';

const urls = [
  process.env.WRAITH_BEFORE_URL ?? 'http://127.0.0.1:5197',
  process.env.WRAITH_URL ?? 'http://127.0.0.1:5196',
];
const output = process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/gpu-visual-options';
const repetitions = Number(process.env.WRAITH_REPETITIONS ?? 3);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [
  'packages/wraith/src/xterm-renderer.ts',
  'packages/wraith/src/xterm-contrast.ts',
  'packages/wraith/wasm/wraith_engine_bg.wasm',
  'scripts/visual-options-benchmark.mjs',
];
const fingerprint = async () =>
  Object.fromEntries(await Promise.all(files.map(async (p) => [p, sha(await readFile(p))])));
const report = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  beforeHead: process.env.WRAITH_BEFORE_HASH ?? null,
  beforeRendererSha256: process.env.WRAITH_BEFORE_SOURCE_ROOT
    ? sha(
        await readFile(
          process.env.WRAITH_BEFORE_SOURCE_ROOT + '/packages/wraith/src/xterm-renderer.ts',
        ),
      )
    : null,
  beforeEngineSha256: process.env.WRAITH_BEFORE_WASM
    ? sha(await readFile(process.env.WRAITH_BEFORE_WASM + '/wraith_engine_bg.wasm'))
    : null,
  cpu: cpus()[0].model,
  logicalCpus: cpus().length,
  urls,
  repetitions,
  sources: await fingerprint(),
  methodology:
    'Rotated before/after production pages. 160x50 at DPR1. Synchronous xterm parse+manual renderer update; 32-update warmup, at least 512 updates and 1000ms, fence every32 GPU updates or force DOM layout. Baseline visual options use DOM fallback; default mode uses GPU on both builds. These are completed logical updates, not display frames. Fixed replay validates text; detailed alpha/contrast pixels are checked separately.',
  results: [],
};
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--force-device-scale-factor=1'],
});
try {
  const pages = [],
    errors = [];
  for (const url of urls) {
    const page = await browser.newPage({
      viewport: { width: 2000, height: 1600 },
      deviceScaleFactor: 1,
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url + '/xterm.html');
    await page.waitForFunction(() => window.compat?.term.renderer === 'webgpu');
    await page.evaluate(() => window.compat.term.dispose());
    pages.push(page);
  }
  report.userAgent = await pages[0].evaluate(() => navigator.userAgent);
  for (const mode of ['plain', 'contrast', 'transparency', 'both'])
    for (const workload of ['dense', 'scroll', 'sparse'])
      for (let repeat = 0; repeat < repetitions; repeat++) {
        for (const build of repeat % 2 ? [1, 0] : [0, 1]) {
          const run = await pages[build].evaluate(
            async ({ mode, workload }) => {
              const term = new window.compat.Terminal({
                cols: 160,
                rows: 50,
                fontSize: 15,
                fontFamily: 'monospace',
                cursorBlink: false,
                minimumContrastRatio: mode === 'contrast' || mode === 'both' ? 7 : 1,
                allowTransparency: mode === 'transparency' || mode === 'both',
                theme: {
                  foreground: '#444444',
                  background: mode === 'transparency' || mode === 'both' ? '#18181880' : '#181818',
                },
              });
              const host = document.createElement('div');
              host.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#241134';
              document.body.append(host);
              term.open(host);
              await term.webgpuReady;
              await new Promise((r) => term.write('\x1b[?25l', r));
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
              const renderer = term._core._renderService._renderer.value;
              const service = term._core._renderService;
              service._renderDebouncer.dispose();
              service._observerDisposable.clear();
              service.refreshRows = () => {};
              if (renderer.timer) clearInterval(renderer.timer);
              const parse = (data) => term._core._inputHandler.parse(data);
              const draw = () => {
                renderer.renderRows(0, 49);
                if (term.renderer === 'dom') void host.offsetHeight;
              };
              const finish = () =>
                term.renderer === 'webgpu' ? renderer.gpu.fence() : Promise.resolve();
              const inputs = Array.from({ length: 32 }, (_, n) => {
                if (workload === 'scroll')
                  return Array.from(
                    { length: 12 },
                    (_, y) =>
                      `\x1b[38;2;${40 + n};44;48mbuild ${n}:${y} ${'compile '.repeat(8)}\x1b[0m\r\n`,
                  ).join('');
                const rows = workload === 'sparse' ? 6 : 50;
                return Array.from(
                  { length: rows },
                  (_, y) =>
                    `\x1b[${workload === 'sparse' ? y * 7 + 1 : y + 1};1H\x1b[38;2;${40 + n};${48 + y};60;48;2;24;24;24m${('row ' + y + ' frame ' + n + ' ABCDEF ').repeat(8).slice(0, 159)}\x1b[0m`,
                ).join('');
              });
              const reset = async () => {
                parse('\x1bc\x1b[?25l');
                for (const input of inputs) {
                  parse(input);
                  draw();
                }
                await finish();
                return Array.from({ length: 50 }, (_, y) =>
                  term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true),
                ).join('\n');
              };
              const text = await reset(),
                actual = term.renderer,
                framesBefore = Number(renderer.gpu.frames),
                start = performance.now();
              let frames = 0;
              do {
                for (let n = 0; n < 32; n++) {
                  parse(inputs[frames % 32]);
                  draw();
                  frames++;
                }
                await finish();
              } while (frames < 512 || performance.now() - start < 1000);
              const elapsedMs = performance.now() - start,
                submitted = Number(renderer.gpu.frames) - framesBefore;
              if (actual === 'webgpu' && submitted !== frames)
                throw Error(`Submitted ${submitted} != counted ${frames}`);
              if ((await reset()) !== text) throw Error('Replay changed text');
              term.dispose();
              host.remove();
              return {
                mode,
                workload,
                renderer: actual,
                frames,
                submitted,
                elapsedMs,
                updatesPerSecond: (frames * 1000) / elapsedMs,
                text,
              };
            },
            { mode, workload },
          );
          run.textSha256 = sha(run.text);
          delete run.text;
          run.build = build === 0 ? 'before' : 'after';
          run.repeat = repeat;
          assert.equal(run.renderer, build === 1 || mode === 'plain' ? 'webgpu' : 'dom');
          report.results.push(run);
          console.log(
            `${mode} ${workload} ${run.build} ${repeat + 1}: ${run.updatesPerSecond.toFixed(0)} updates/s (${run.renderer})`,
          );
          await writeFile(output + '/runs.json', JSON.stringify(report, null, 2) + '\n');
        }
      }
  for (const mode of ['plain', 'contrast', 'transparency', 'both'])
    for (const workload of ['dense', 'scroll', 'sparse']) {
      const hashes = new Set(
        report.results
          .filter((r) => r.mode === mode && r.workload === workload)
          .map((r) => r.textSha256),
      );
      assert.equal(hashes.size, 1, `${mode} ${workload} text differs`);
    }
  assert.deepEqual(await fingerprint(), report.sources, 'Sources changed during benchmark');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
