// Fleet profile: one headed run of demo/fleet.html with a Chrome trace of the
// main thread and every worker, summarized as busy time per thread, self time
// per trace event and self time per JavaScript/Wasm function (sampled).
//   HEADED=1 WRAITH_URL=http://127.0.0.1:5173 COUNT=1000 node scripts/fleet-profile.mjs
// FEED=main|worker, WORKERS, SECONDS, WARM, TRACE (keep the raw trace at this path),
// ANALYZE=<trace.json> (summarize an existing trace without running).
import { chromium } from '@playwright/test';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const count = Number(process.env.COUNT ?? 1000);
const feed = process.env.FEED ?? 'main';
const workers = Number(process.env.WORKERS ?? 4);
const seconds = Number(process.env.SECONDS ?? 3);
const warm = Number(process.env.WARM ?? 3);
const tracePath =
  process.env.ANALYZE ?? process.env.TRACE ?? join(tmpdir(), `fleet-trace-${process.pid}.json`);

if (!process.env.ANALYZE) {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: process.env.HEADED !== '1',
    args: ['--window-position=0,0'],
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
  });
  page.setDefaultTimeout(240_000);
  await page.goto(`${base}/fleet.html?auto=0`);
  await page.waitForFunction(() => window.fleet);
  await page.evaluate((o) => window.fleet.start(o), { count, mode: 'shared', feed, workers });
  await page.waitForTimeout(warm * 1000);
  const a = await page.evaluate(() => window.fleet.metrics());
  await browser.startTracing(page, {
    path: tracePath,
    categories: [
      'toplevel',
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'v8',
      'v8.execute',
      'blink',
      'gpu',
      'disabled-by-default-v8.cpu_profiler',
    ],
  });
  await page.waitForTimeout(seconds * 1000);
  await browser.stopTracing();
  const b = await page.evaluate(() => window.fleet.metrics());
  await page.evaluate(() => window.fleet.stop());
  await browser.close();

  const s = (b.time - a.time) / 1000;
  const per = b.acked.map((v, i) => (v - a.acked[i]) / s).sort((x, y) => x - y);
  console.log(
    `${count} terminals, feed ${feed}, ${workers} workers (whole window ${s.toFixed(1)} s incl. tracing): ` +
      `display ${((b.frames - a.frames) / s).toFixed(1)} rAF/s, ` +
      `${(per.reduce((x, y) => x + y, 0) / count).toFixed(1)} updates/terminal/s, p10 ${per[Math.floor(count * 0.1)].toFixed(1)}`,
  );
}
// Traces of a few seconds run to hundreds of MB: parse one event at a time.
const traceEvents = [];
let partial = '';
for await (const line of createInterface({ input: createReadStream(tracePath) })) {
  if (line.startsWith('{"traceEvents"')) continue;
  partial += line;
  const text = partial.replace(/,\s*$/, '').replace(/\]\s*\}?\s*$/, '');
  if (!text.trim()) {
    partial = '';
    continue;
  }
  try {
    const e = JSON.parse(text);
    partial = '';
    // Keep only what the summary uses.
    if (e.ph === 'M' || e.ph === 'X' || e.name === 'Profile' || e.name === 'ProfileChunk')
      traceEvents.push(e);
  } catch {
    // An event spanning several lines.
  }
}
if (!process.env.TRACE && !process.env.ANALYZE) await rm(tracePath);
const names = new Map();
for (const e of traceEvents)
  if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
let window0 = Infinity,
  window1 = -Infinity;
for (const e of traceEvents)
  if (e.ph === 'X' && e.ts > 0) {
    window0 = Math.min(window0, e.ts);
    window1 = Math.max(window1, e.ts + (e.dur ?? 0));
  }
const traceSeconds = (window1 - window0) / 1e6;

// Self time per event name per thread, from complete ('X') events.
const byThread = new Map();
const groups = new Map();
for (const e of traceEvents) {
  if (e.ph !== 'X' || !e.dur) continue;
  const key = `${e.pid}:${e.tid}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}
for (const [key, events] of groups) {
  const name = names.get(key) ?? key;
  if (!/CrRendererMain|DedicatedWorker|Compositor|VizCompositor|CrGpuMain|Wraith/.test(name))
    continue;
  events.sort((x, y) => x.ts - y.ts || y.dur - x.dur);
  const self = new Map();
  let busy = 0;
  const open = [];
  const flush = (f) => self.set(f.name, (self.get(f.name) ?? 0) + f.self);
  for (const e of events) {
    while (open.length && open.at(-1).end <= e.ts) flush(open.pop());
    const parent = open.at(-1);
    if (parent) parent.self -= Math.min(e.dur, parent.end - e.ts);
    else busy += e.dur;
    open.push({ name: e.name, end: e.ts + e.dur, self: e.dur });
  }
  while (open.length) flush(open.pop());
  byThread.set(`${name} (${key})`, { busy, self });
}
console.log(`\nTrace ${traceSeconds.toFixed(2)} s. Busy time per thread (top-level events):`);
for (const [name, { busy, self }] of [...byThread].sort((x, y) => y[1].busy - x[1].busy)) {
  if (busy < 20_000) continue;
  console.log(
    `  ${name}: ${(busy / 1e3).toFixed(0)} ms (${(busy / 1e4 / traceSeconds).toFixed(0)}%)`,
  );
  for (const [event, us] of [...self].sort((x, y) => y[1] - x[1]).slice(0, 12))
    if (us > 5_000) console.log(`      ${(us / 1e3).toFixed(0).padStart(6)} ms  ${event}`);
}

// Sampled CPU profiles: self time per function per thread.
const profiles = new Map();
for (const e of traceEvents) {
  if (e.name === 'Profile')
    profiles.set(`${e.pid}:${e.id}`, {
      thread: `${e.pid}:${e.tid}`,
      nodes: new Map(),
      self: new Map(),
    });
  if (e.name !== 'ProfileChunk') continue;
  const p = profiles.get(`${e.pid}:${e.id}`);
  if (!p) continue;
  const data = e.args.data;
  for (const node of data.cpuProfile?.nodes ?? []) p.nodes.set(node.id, node.callFrame);
  const samples = data.cpuProfile?.samples ?? [];
  const deltas = data.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const frame = p.nodes.get(samples[i]);
    const label = frame
      ? `${frame.functionName || '(anonymous)'} ${String(frame.url ?? '')
          .split('/')
          .pop()}:${frame.lineNumber ?? ''}`
      : '?';
    p.self.set(label, (p.self.get(label) ?? 0) + (deltas[i + 1] ?? deltas[i] ?? 0));
  }
}
console.log('\nSampled self time per function:');
for (const p of profiles.values()) {
  const name = names.get(p.thread) ?? p.thread;
  const total = [...p.self.values()].reduce((x, y) => x + y, 0);
  if (total < 50_000) continue;
  console.log(`  ${name} (${p.thread}): ${(total / 1e3).toFixed(0)} ms sampled`);
  for (const [label, us] of [...p.self].sort((x, y) => y[1] - x[1]).slice(0, 18))
    console.log(`      ${(us / 1e3).toFixed(0).padStart(6)} ms  ${label}`);
}
