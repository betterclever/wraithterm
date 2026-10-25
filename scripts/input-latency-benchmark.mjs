// Keystroke-to-pixel latency for the native profile, through `wraithterm serve`.
//
// The PTY runs `stty raw -echo; exec cat`, so every typed byte is echoed by a
// process (like a shell line editor) over a constant loopback WebSocket. Each
// keystroke is timed on one clock (performance.timeOrigin + now) at:
//   keydown   KeyboardEvent.timeStamp on the page
//   key       key command received in the engine worker
//   sent      encoded bytes handed to WebSocket.send on the page
//   echo      echo message received on the page
//   parsed    echo parsed by libghostty-vt in the worker
//   submit    frame containing the echo submitted (queue.submit returned)
//   gpu       GPUQueue.onSubmittedWorkDone for that frame
//   frame     the worker's next requestAnimationFrame after submit
// `frame` is a weak presentation proxy (the next BeginFrame after submit): a
// WebGPU OffscreenCanvas exposes no presentation feedback. Unless
// WRAITH_TRACE=0, each block also records Chrome's viz trace, adding:
//   received  the canvas CompositorFrame reached viz
//   swap      the display frame drawing it was swapped (SwapBuffers ack)
//   vsync     the next vsync callback after that swap
// Physical scanout (panel latency) is not measured.
//
// Variants run interleaved in one session (A/B/B/A per round), idle and with
// background output (a log tail written by a second process on the same PTY).
//
//   npm run build:sdk && npm run benchmark:input-latency
// Env: WRAITH_KEYS (per block, default 100), WRAITH_ROUNDS (default 3),
// WRAITH_VARIANTS (default frame,immediate), WRAITH_CONDITIONS (idle,output),
// WRAITH_SERVE_PORT (default 6224), WRAITH_HEADLESS=1, WRAITH_TRACE=0,
// WRAITH_FLOOD_MB (default 32; 0 skips) and WRAITH_REPORT (output JSON path).
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir, cpus, loadavg, release } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'packages/wraith/bin/wraithterm.mjs');
const keysPerBlock = Number(process.env.WRAITH_KEYS ?? 100);
const rounds = Number(process.env.WRAITH_ROUNDS ?? 3);
const variants = (process.env.WRAITH_VARIANTS ?? 'frame,immediate').split(',');
const conditions = (process.env.WRAITH_CONDITIONS ?? 'idle,output').split(',');
const port = Number(process.env.WRAITH_SERVE_PORT ?? 6224);
const tracing = process.env.WRAITH_TRACE !== '0';
const report = resolve(
  process.env.WRAITH_REPORT ?? join(root, '.cache/input-latency', `run-${Date.now()}.json`),
);
const VARIANTS = {
  // Baseline: every frame waits for the worker's next animation frame.
  frame: { immediate: false },
  // Shipped default: a write to an idle terminal renders at once.
  immediate: { immediate: true },
};
for (const v of variants) if (!VARIANTS[v]) throw new Error(`Unknown variant ${v}`);

// Background output: ~2,000 lines/s of 100 uppercase/digit bytes (no a-z, so
// lowercase bytes identify echoes) while the flag file exists.
const work = mkdtempSync(join(tmpdir(), 'wraith-latency-'));
const flag = join(work, 'output');
// Throughput guard: a flood of WRAITH_FLOOD_MB (default 32) per variant and
// round, timed from its first message on the page to its end marker parsed.
const floodFlag = join(work, 'flood');
const floodMiB = Number(process.env.WRAITH_FLOOD_MB ?? 32);
const generator = join(work, 'output.py');
writeFileSync(
  generator,
  `import os, sys, time
flag, flood, mib = sys.argv[1], sys.argv[2], int(sys.argv[3])
n = 0
line = ('FLOOD ' + '0123456789 ABCDEFGHIJ #### ' * 4)[:98] + '\\r\\n'
chunk = (line * (65536 // len(line))).encode()
while True:
    if os.path.exists(flood):
        os.remove(flood)
        sent = 0
        while sent < mib << 20:
            os.write(1, chunk)
            sent += len(chunk)
        os.write(1, b'x\\r\\n')
    if os.path.exists(flag):
        lines = []
        for _ in range(20):
            n += 1
            lines.append(('BUILD %08d ' % n) + ('0123456789 ABCDEF #### ' * 4)[:86] + '\\r\\n')
        os.write(1, ''.join(lines).encode())
    time.sleep(0.01)
`,
);
const script = `stty raw -echo; python3 ${generator} ${flag} ${floodFlag} ${floodMiB} & exec cat`;
const server = spawn(
  process.execPath,
  [cli, 'serve', '--port', String(port), '--no-install', '--', '/bin/sh', '-c', script],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
const link = await new Promise((done, fail) => {
  server.stdout.on('data', (d) => {
    serverOutput += d;
    const match = serverOutput.match(/http:\/\/\S+token=\w+/);
    if (match) done(match[0]);
  });
  server.stderr.on('data', (d) => (serverOutput += d));
  server.on('exit', (code) => fail(new Error(`serve exited ${code}: ${serverOutput}`)));
  setTimeout(() => fail(new Error(`no URL: ${serverOutput}`)), 20000);
});

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: process.env.WRAITH_HEADLESS === '1',
  // A headed window can be occluded by other windows; keep its frames running.
  args: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const round3 = (v) => (v === null ? null : Math.round(v * 1000) / 1000);
const summarize = (values) => ({
  n: values.length,
  p50: round3(percentile(values, 0.5)),
  p90: round3(percentile(values, 0.9)),
  p99: round3(percentile(values, 0.99)),
  max: round3(values.length ? Math.max(...values) : null),
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const now = () => performance.timeOrigin + performance.now();
    const lat = (window.__latency = {
      keydown: [],
      sent: [],
      echo: [],
      trace: [],
      waiter: null,
    });
    const lower = (bytes) => {
      for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x61 && bytes[i] <= 0x7a) return true;
      return false;
    };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data !== 'string') lat.sent.push(now());
      return send.call(this, data);
    };
    const add = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (type, listener, options) {
      if (type !== 'message') return add.call(this, type, listener, options);
      return add.call(
        this,
        type,
        (event) => {
          if (lat.armed) {
            lat.armed = false;
            lat.floodStart = now();
          }
          if (event.data instanceof ArrayBuffer && lower(new Uint8Array(event.data)))
            lat.echo.push(now());
          listener(event);
        },
        options,
      );
    };
    addEventListener(
      'keydown',
      (e) => lat.keydown.push(performance.timeOrigin + e.timeStamp),
      true,
    );
  });
  await page.goto(link);
  await page.waitForFunction(() => window.wraith, null, { timeout: 30000 });
  const info = await page.evaluate(async () => {
    const term = window.wraith;
    const lat = window.__latency;
    const receive = term.receive.bind(term);
    term.receive = (reply) => {
      if (reply.type !== 'trace') return receive(reply);
      lat.trace.push(reply);
      if (reply.stage === 'frame' && lat.waiter) lat.waiter();
    };
    term.send({ type: 'trace', enabled: true });
    await new Promise((r) => setTimeout(r, 500));
    return {
      cols: term.cols,
      rows: term.rows,
      dpr: devicePixelRatio,
      userAgent: navigator.userAgent,
      stats: await new Promise((r) => {
        const d = term.onStats((s) => (d.dispose(), r(s.adapter)));
      }),
    };
  });
  console.log(`grid ${info.cols}x${info.rows} dpr ${info.dpr} ${info.stats}`);
  // Chrome's viz pipeline trace: when the canvas frame reached the display
  // compositor, when that display frame was swapped, and the next vsync.
  const traceCategories = ['viz', 'gpu', 'blink.user_timing'];
  function attachTrace(samples, trace, timeOrigin) {
    const events = trace.traceEvents ?? trace;
    const mark = events.find((e) => e.name === 'wraith-latency-calibration');
    if (!mark) throw new Error('Trace calibration mark missing');
    const offset = mark.ts - mark.args.data.startTime * 1000;
    const toTs = (abs) => (abs - timeOrigin) * 1000 + offset;
    const toAbs = (ts) => (ts - offset) / 1000 + timeOrigin;
    const pipeline = (step) =>
      events
        .filter((e) => e.name === 'Graphics.Pipeline' && e.ph === 'X')
        .filter((e) => e.args?.chrome_graphics_pipeline?.step === step);
    const receives = pipeline('STEP_RECEIVE_COMPOSITOR_FRAME')
      // OffscreenCanvas frame sinks are client-allocated (high bit set).
      .filter((e) => e.args.chrome_graphics_pipeline.frame_sink_id?.frame_sink_id >= 2 ** 31)
      .map((e) => e.ts)
      .sort((a, b) => a - b);
    const draws = pipeline('STEP_DRAW_AND_SWAP')
      .map((e) => e.ts)
      .sort((a, b) => a - b);
    const acks = pipeline('STEP_SWAP_BUFFERS_ACK')
      .map((e) => e.ts + (e.dur ?? 0))
      .sort((a, b) => a - b);
    const vsyncs = events
      .filter((e) => e.name === 'OnVSyncPresentation')
      .sort((a, b) => a.ts - b.ts);
    const first = (list, ts) => list.find((x) => x >= ts);
    for (const sample of samples) {
      if (sample.submit === undefined) continue;
      // Allow for coarsened timers: the frame commits when the worker task ends.
      const received = first(receives, toTs(sample.submit) - 200);
      const draw = received !== undefined ? first(draws, received) : undefined;
      const swap = draw !== undefined ? first(acks, draw) : undefined;
      const vsync = swap !== undefined ? vsyncs.find((e) => e.ts >= swap) : undefined;
      if (received !== undefined) sample.received = toAbs(received);
      if (swap !== undefined) sample.swap = toAbs(swap);
      if (vsync) {
        sample.vsync = toAbs(vsync.ts);
        sample.vsyncToDisplayUs = vsync.args?.callback_timebase_to_display;
      }
    }
  }
  async function traced(run) {
    if (!tracing) return run();
    await browser.startTracing(page, { categories: traceCategories });
    const timeOrigin = await page.evaluate(() => {
      performance.mark('wraith-latency-calibration');
      return performance.timeOrigin;
    });
    const samples = await run();
    attachTrace(samples, JSON.parse(await browser.stopTracing()), timeOrigin);
    return samples;
  }

  async function keystroke(ch) {
    await page.evaluate(() => {
      const lat = window.__latency;
      lat.keydown.length = lat.sent.length = lat.echo.length = lat.trace.length = 0;
      lat.done = new Promise((r) => (lat.waiter = r));
    });
    await page.keyboard.press(ch);
    return page.evaluate(async (ch) => {
      const lat = window.__latency;
      const timeout = new Promise((r) => setTimeout(r, 2000));
      // The frame trace may need a further write; wait for the parsed echo's frame.
      for (;;) {
        const parsed = lat.trace.find((t) => t.stage === 'parsed');
        if (parsed && lat.trace.some((t) => t.stage === 'frame' && t.time >= parsed.time)) break;
        if ((await Promise.race([lat.done.then(() => 1), timeout.then(() => 0)])) === 0) break;
        lat.done = new Promise((r) => (lat.waiter = r));
      }
      // GPU completion can land after the next animation frame.
      await new Promise((r) => setTimeout(r, 30));
      const keydown = lat.keydown.at(-1);
      const after = (list, t) => list.find((x) => x >= t);
      const stage = (name, t) => lat.trace.find((x) => x.stage === name && x.time >= t)?.time;
      // Order main-thread stages on the page clock and worker stages on the
      // worker clock: the two clocks agree only to coarsened-timer precision.
      const key = lat.trace.find((x) => x.stage === 'key' && x.info === ch)?.time;
      const sent = keydown !== undefined ? after(lat.sent, keydown) : undefined;
      const echo = sent !== undefined ? after(lat.echo, sent) : undefined;
      const parsed = key !== undefined && echo !== undefined ? stage('parsed', key) : undefined;
      const submit = parsed !== undefined ? stage('submit', parsed) : undefined;
      const gpu = submit !== undefined ? stage('gpu', submit) : undefined;
      const frame = submit !== undefined ? stage('frame', submit) : undefined;
      return { keydown, key, sent, echo, parsed, submit, gpu, frame };
    }, ch);
  }
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const blocks = [];
  let keyIndex = 0;
  const startedAt = new Date().toISOString();
  const loadBefore = loadavg();
  // Warm up the glyph atlas and both paths.
  for (const v of variants) {
    await page.evaluate((o) => window.wraith.send({ type: 'trace', ...o }), VARIANTS[v]);
    for (let i = 0; i < 30; i++) await keystroke(letters[i % 26]);
  }
  const floods = [];
  async function flood(variant) {
    await page.evaluate((o) => window.wraith.send({ type: 'trace', ...o }), VARIANTS[variant]);
    await page.evaluate(() => {
      const lat = window.__latency;
      lat.trace.length = 0;
      lat.armed = true;
      lat.floodStart = undefined;
    });
    writeFileSync(floodFlag, '');
    const result = await page.evaluate(async () => {
      const lat = window.__latency;
      const deadline = performance.now() + 120000;
      while (!lat.trace.some((t) => t.stage === 'parsed') && performance.now() < deadline)
        await new Promise((r) => setTimeout(r, 5));
      const parsed = lat.trace.find((t) => t.stage === 'parsed')?.time;
      await window.wraith.flush();
      return { start: lat.floodStart, parsed, flushed: performance.timeOrigin + performance.now() };
    });
    const mbps = (floodMiB * 1.048576) / ((result.parsed - result.start) / 1000);
    floods.push({ variant, mib: floodMiB, ...result, mbPerSecond: mbps, load: loadavg()[0] });
    console.log(`flood ${variant.padEnd(9)} ${mbps.toFixed(1)} MB/s`);
    await new Promise((r) => setTimeout(r, 300));
  }
  if (floodMiB > 0) await flood(variants[0]); // warm-up, discarded below
  floods.length = 0;
  for (let round = 0; round < rounds; round++) {
    if (floodMiB > 0)
      for (const v of round % 2 ? [...variants].reverse() : variants) await flood(v);
    for (const condition of conditions) {
      if (condition === 'output') writeFileSync(flag, '');
      else rmSync(flag, { force: true });
      await new Promise((r) => setTimeout(r, 300));
      const order = round % 2 ? [...variants].reverse() : variants;
      for (const variant of order) {
        await page.evaluate((o) => window.wraith.send({ type: 'trace', ...o }), VARIANTS[variant]);
        const samples = await traced(async () => {
          const samples = [];
          for (let i = 0; i < keysPerBlock; i++) {
            samples.push(await keystroke(letters[keyIndex++ % 26]));
            // Decorrelate keystrokes from the display's frame phase.
            await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
          }
          return samples;
        });
        blocks.push({ round, condition, variant, load: loadavg()[0], samples });
        const ok = samples.filter((s) => s.frame !== undefined);
        const p50 = percentile(
          ok.map((s) => s.frame - s.keydown),
          0.5,
        );
        console.log(
          `round ${round} ${condition.padEnd(6)} ${variant.padEnd(9)} keydown->frame p50 ${p50?.toFixed(2)} ms (${ok.length}/${samples.length})`,
        );
      }
    }
  }
  rmSync(flag, { force: true });
  const stages = [
    ['keydown', 'key'],
    ['key', 'sent'],
    ['sent', 'echo'],
    ['echo', 'parsed'],
    ['parsed', 'submit'],
    ['submit', 'gpu'],
    ['submit', 'frame'],
    ['keydown', 'submit'],
    ['keydown', 'gpu'],
    ['keydown', 'frame'],
    ...(tracing
      ? [
          ['submit', 'received'],
          ['received', 'swap'],
          ['swap', 'vsync'],
          ['keydown', 'swap'],
          ['keydown', 'vsync'],
        ]
      : []),
  ];
  const summary = {};
  for (const condition of conditions)
    for (const variant of variants) {
      const samples = blocks
        .filter((b) => b.condition === condition && b.variant === variant)
        .flatMap((b) => b.samples);
      const complete = samples.filter(
        (s) => s.frame !== undefined && s.gpu !== undefined && (!tracing || s.vsync !== undefined),
      );
      summary[`${condition}/${variant}`] = {
        keystrokes: samples.length,
        complete: complete.length,
        ...Object.fromEntries(
          stages.map(([a, b]) => [`${a}->${b}`, summarize(complete.map((s) => s[b] - s[a]))]),
        ),
        blockP50KeydownToFrame: blocks
          .filter((b) => b.condition === condition && b.variant === variant)
          .map((b) =>
            round3(
              percentile(
                b.samples.filter((s) => s.frame !== undefined).map((s) => s.frame - s.keydown),
                0.5,
              ),
            ),
          ),
      };
    }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages', 'crates'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const result = {
    harness: 'scripts/input-latency-benchmark.mjs',
    startedAt,
    head,
    dirtyEngineOrSdk: dirty.length > 0,
    machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, os: release() },
    load: { before: loadBefore, after: loadavg() },
    sharedMachine: true,
    config: {
      keysPerBlock,
      rounds,
      variants,
      conditions,
      headless: process.env.WRAITH_HEADLESS === '1',
      chromeTrace: tracing ? traceCategories : false,
      echo: 'stty raw -echo; exec cat (PTY via wraithterm serve)',
      output: '~2,000 lines/s x 100 B from a second process on the same PTY',
    },
    page: info,
    summary,
    flood: Object.fromEntries(
      variants.map((v) => {
        const runs = floods.filter((f) => f.variant === v).map((f) => f.mbPerSecond);
        return [
          v,
          {
            runs: runs.map(round3),
            median: round3(percentile(runs, 0.5)),
            min: round3(Math.min(...runs)),
            max: round3(Math.max(...runs)),
          },
        ];
      }),
    ),
    floods,
    errors,
    blocks,
  };
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify(result, null, 1) + '\n');
  for (const [name, s] of Object.entries(summary)) {
    if (tracing)
      console.log(
        `${name.padEnd(17)} n=${s.complete} keydown->swap p50 ${s['keydown->swap'].p50} p90 ${s['keydown->swap'].p90} p99 ${s['keydown->swap'].p99} | ->vsync p50 ${s['keydown->vsync'].p50} p90 ${s['keydown->vsync'].p90} p99 ${s['keydown->vsync'].p99}`,
      );
    console.log(
      `${name.padEnd(17)} n=${s.complete} keydown->submit p50 ${s['keydown->submit'].p50} p90 ${s['keydown->submit'].p90} p99 ${s['keydown->submit'].p99} | ->frame p50 ${s['keydown->frame'].p50} p90 ${s['keydown->frame'].p90} p99 ${s['keydown->frame'].p99}`,
    );
  }
  console.log(`wrote ${report}`);
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
  server.kill();
  rmSync(work, { recursive: true, force: true });
}
