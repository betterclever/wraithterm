// CPU profile of the Wraith engine worker while a workload is written straight
// into Wraith.mount(). Attaches to the dedicated worker through the page's CDP
// session and prints self time by function (Wasm names need a build that keeps
// the name section, e.g. wasm-bindgen --keep-debug and wasm-opt -g).
//
//   VARIANT=.cache/ab/prof FILE=/path/logs.ansi node scripts/profile-engine-worker.mjs [out.cpuprofile]
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5223';
const dir = resolve(process.env.VARIANT ?? 'packages/wraith');
const file = process.env.FILE;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: process.env.HEADLESS === '1',
  args: ['--window-position=0,0', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({
  viewport: { width: 1374, height: 980 },
  deviceScaleFactor: 2,
});
await page.route('**/__workload', (r) => r.fulfill({ body: readFileSync(file) }));
await page.route('**/__engine-bench.html', (r) =>
  r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }),
);
await page.goto(`${base}/__engine-bench.html`);
const cdp = await page.context().newCDPSession(page);
let next = 1;
const waiting = new Map();
let workerSession;
const attached = new Promise((done) =>
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    if (targetInfo.type === 'worker' && !workerSession) {
      workerSession = sessionId;
      done();
    }
  }),
);
cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
  const m = JSON.parse(message);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((done) => {
    const id = next++;
    waiting.set(id, done);
    cdp.send('Target.sendMessageToTarget', {
      sessionId: workerSession,
      message: JSON.stringify({ id, method, params }),
    });
  });
await cdp.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: false,
});
await page.evaluate(
  async ({ url, warm }) => {
    const { Wraith } = await import(url);
    document.body.innerHTML = '<div id=t style="position:fixed;inset:6px"></div>';
    window.term = await Wraith.mount(document.getElementById('t'), {
      cols: 160,
      rows: 50,
      fit: false,
      fontSize: 14,
    });
    window.bytes = new Uint8Array(await (await fetch('/__workload')).arrayBuffer());
    if (warm) {
      // Profile steady state: one untimed pass, then a full reset.
      for (let i = 0; i < window.bytes.length; i += 65536)
        await window.term.write(window.bytes.subarray(i, i + 65536));
      await window.term.write('\x1bc');
      await window.term.flush();
    }
  },
  { url: `/@fs${dir}/dist/index.js`, warm: process.env.WARM === '1' },
);
await attached;
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 200 });
await send('Profiler.start');
const seconds = await page.evaluate(async () => {
  const { term, bytes } = window;
  const start = performance.now();
  let last;
  for (let i = 0; i < bytes.length; i += 65536) {
    last = term.write(bytes.subarray(i, i + 65536));
    if ((i / 65536) % 64 === 63) await last;
  }
  await last;
  await term.flush();
  return (performance.now() - start) / 1000;
});
const { result } = await send('Profiler.stop');
const profile = result.profile;
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(profile));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
let total = 0;
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const k = n.callFrame.functionName || `(anon ${n.callFrame.url.split('/').pop()})`;
  const dt = profile.timeDeltas[i] ?? 0;
  total += dt;
  self.set(k, (self.get(k) ?? 0) + dt);
});
console.log(
  `${file.split('/').pop()}: ${(bytes(file) / seconds / 1e6).toFixed(1)} MB/s, profiled ${(total / 1e3).toFixed(0)} ms`,
);
for (const [k, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP ?? 40)))
  console.log(
    `${((100 * t) / total).toFixed(1).padStart(5)}%  ${(t / 1e3).toFixed(0).padStart(6)} ms  ${k}`,
  );
function bytes(f) {
  return readFileSync(f).length;
}
await browser.close();
