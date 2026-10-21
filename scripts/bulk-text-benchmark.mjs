import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, release } from 'node:os';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5196';
const sourceRoot = process.env.WRAITH_SOURCE_ROOT ?? process.cwd();
const output = process.env.WRAITH_REPORT_DIR ?? 'docs/benchmarks/bulk-text/after';
const repeats = Number(process.env.WRAITH_REPETITIONS ?? 5);
const cases = (process.env.WRAITH_CASES ?? 'paste,write,nowrap,logs,blocks').split(',');
const providers = (process.env.WRAITH_UNICODE ?? '6,11').split(',');
const types = (process.env.WRAITH_TYPES ?? 'dom,wraith').split(',');
const grids = (process.env.WRAITH_GRIDS ?? '80x24,160x50')
  .split(',')
  .map((s) => s.split('x').map(Number));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const files = [
  'packages/wraith/src/xterm-print.ts',
  'packages/wraith/src/xterm-input.ts',
  'packages/wraith/src/xterm-parser.js',
  'packages/wraith/wasm/wraith_engine_bg.wasm',
  'scripts/bulk-text-benchmark.mjs',
];
const sources = async () =>
  Object.fromEntries(
    await Promise.all(files.map(async (p) => [p, sha(await readFile(`${sourceRoot}/${p}`))])),
  );
assert(repeats >= 1 && repeats <= 10 && Number.isInteger(repeats));
assert(cases.every((s) => ['paste', 'write', 'nowrap', 'logs', 'blocks'].includes(s)));
assert(providers.every((s) => ['6', '11'].includes(s)));
const report = {
  date: new Date().toISOString(),
  head:
    process.env.WRAITH_BUILD_HASH ??
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sources: await sources(),
  cpu: cpus()[0].model,
  logicalCpus: cpus().length,
  os: `${process.platform} ${release()}`,
  xterm: JSON.parse(await readFile('node_modules/@xterm/xterm/package.json')).version,
  config: { repeats, cases, providers, types, grids },
  methodology:
    'Production page; rotated renderer order. Public paste includes bracketed-paste event plus write echo; write measures public parse callback. Separate warm synchronous parser-only throughput disables render scheduling, 4 warm iterations then 16 measured; this does not measure GPU/display frames. Complete bounded buffer raw cells, combined strings, wrap flags and cursor are hashed after measurement. Unicode11 is an explicit unchanged fallback control. Scrollback 1000; stock font and cursorBlink=false. First public operation is retained separately from warm parse. Profile runs are separate from timing.',
  results: [],
};
await mkdir(output, { recursive: true });
const save = () => writeFile(`${output}/runs.json`, JSON.stringify(report, null, 2) + '\n');
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 2200, height: 1500 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/xterm.html');
  await page.waitForFunction(() => window.compat?.term.renderer === 'webgpu');
  await page.evaluate(() => window.compat.term.dispose());
  report.userAgent = await page.evaluate(() => navigator.userAgent);
  for (const [cols, rows] of grids)
    for (const provider of providers)
      for (const kind of cases)
        for (let repeat = 0; repeat < repeats; repeat++)
          for (const type of repeat % 2 ? [...types].reverse() : types) {
            const result = await page.evaluate(
              async ({ cols, rows, provider, kind, type }) => {
                const Constructor =
                  type === 'wraith' ? window.compat.Terminal : window.compat.OriginalTerminal;
                const host = document.createElement('div');
                host.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:black';
                document.body.append(host);
                const term = new Constructor({
                  cols,
                  rows,
                  scrollback: 1000,
                  cursorBlink: false,
                  allowProposedApi: true,
                  fontFamily: 'monospace',
                  fontSize: 15,
                });
                if (provider === '11') {
                  term.loadAddon(new window.compat.Unicode11Addon());
                  term.unicode.activeVersion = '11';
                }
                term.open(host);
                if (type === 'wraith' && !(await term.webgpuReady)) throw Error('WebGPU failed');
                const write = (s) => new Promise((r) => term.write(s, r));
                const frame = () => new Promise((r) => requestAnimationFrame(r));
                const settle = async () => {
                  await frame();
                  await frame();
                  if (type === 'wraith') {
                    if (term.renderer !== 'webgpu') throw Error(term.rendererFallbackReason);
                    await term._core._renderService._renderer.value.gpu.fence();
                  }
                };
                const snapshot = async () => {
                  const b = term.buffer.active;
                  const state = [b.cursorX, b.cursorY, b.baseY, b.viewportY, b.length];
                  for (let i = 0; i < b.length; i++) {
                    const row = b.getLine(i),
                      raw = row._line;
                    state.push([
                      row.isWrapped,
                      Array.from(raw._data),
                      raw._combined,
                      raw._extendedAttrs,
                    ]);
                  }
                  return Array.from(
                    new Uint8Array(
                      await crypto.subtle.digest(
                        'SHA-256',
                        new TextEncoder().encode(JSON.stringify(state)),
                      ),
                    ),
                  )
                    .map((n) => n.toString(16).padStart(2, '0'))
                    .join('');
                };
                let text;
                if (kind === 'logs')
                  text = '\x1b[32mbuild compile module INFO work output\x1b[0m\r\n'.repeat(16384);
                else if (kind === 'blocks') text = '▀▄█░▒▓─│┼'.repeat(32768);
                else text = 'abcdefgh01234567'.repeat(kind === 'write' ? 262144 : 65536);
                const bytes = new TextEncoder().encode(text).length;
                const prefix = '\x1b[?25l\x1b[?2004h' + (kind === 'nowrap' ? '\x1b[?7l' : '');
                await write(prefix);
                await settle();
                const start = performance.now();
                let echoBytes;
                if (kind === 'paste') {
                  let echoed, done;
                  const received = new Promise((r) => (done = r));
                  const subscription = term.onData((data) => {
                    echoBytes = data.length;
                    echoed = write(data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, ''));
                    done();
                  });
                  term.paste(text);
                  await received;
                  await echoed;
                  subscription.dispose();
                  if (echoBytes !== text.length + 12) throw Error('Paste framing mismatch');
                } else await write(text);
                const publicMs = performance.now() - start;
                await settle();
                const publicHash = await snapshot();
                const render = term._core._renderService;
                render._renderDebouncer.dispose();
                render._observerDisposable.clear();
                render.refreshRows = () => {};
                const renderer = render._renderer.value;
                if (renderer.timer) clearInterval(renderer.timer);
                const parse = term._core._inputHandler.parse.bind(term._core._inputHandler);
                term.reset();
                parse(prefix);
                for (let i = 0; i < 4; i++) parse(text);
                const durations = [],
                  parseStart = performance.now();
                for (let i = 0; i < 16; i++) {
                  const at = performance.now();
                  parse(text);
                  durations.push(performance.now() - at);
                }
                const parseMs = performance.now() - parseStart;
                // Fixed replay uses exactly one public operation's terminal state.
                term.reset();
                parse(prefix);
                parse(text);
                const replayHash = await snapshot();
                if (publicHash !== replayHash) throw Error('Public and synchronous replay differ');
                term.dispose();
                host.remove();
                return {
                  publicMs,
                  bytes,
                  parseMs,
                  iterations: 16,
                  parseMiBPerSecond: (bytes * 16) / 1048576 / (parseMs / 1000),
                  durations,
                  publicHash,
                  replayHash,
                  echoBytes,
                };
              },
              { cols, rows, provider, kind, type },
            );
            report.results.push({ cols, rows, provider, kind, repeat, type, ...result });
            console.log(
              JSON.stringify({
                cols,
                rows,
                provider,
                kind,
                repeat,
                type,
                publicMs: result.publicMs,
                parseMiBPerSecond: result.parseMiBPerSecond,
              }),
            );
            await save();
          }
  for (const r of report.results) {
    const reference = report.results.find(
      (x) =>
        x.cols === r.cols &&
        x.rows === r.rows &&
        x.provider === r.provider &&
        x.kind === r.kind &&
        x.type === 'dom',
    );
    if (reference)
      assert.equal(r.publicHash, reference.publicHash, `State mismatch: ${r.kind} ${r.type}`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(await sources(), report.sources, 'Measured source changed');
} finally {
  await save();
  await browser.close();
}
