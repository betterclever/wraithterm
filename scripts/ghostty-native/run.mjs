// Interleaved PTY throughput: native Ghostty against `wraithterm serve` in headed
// Chrome. Both run probe.py through a real PTY, which writes each workload and
// then a cursor-position query: the reply proves every earlier byte was parsed.
// FILES=a.ansi,b.ansi ROUNDS=3 node scripts/ghostty-native/run.mjs
// PORT picks serve's port, SERVE_BIN a serve script (default this checkout's),
// and ONLY=wraith or ONLY=ghostty runs one side. The page records when each
// WebSocket message arrives, so the result shows whether the browser kept up.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const repo = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(repo + '/package.json');
const { chromium } = require('playwright');
const here = new URL('.', import.meta.url).pathname;
const rounds = Number(process.env.ROUNDS ?? 3),
  reps = Number(process.env.REPS ?? 1);
const files = (process.env.FILES ?? 'small.ansi')
  .split(',')
  .map((f) => (f.startsWith('/') ? f : process.cwd() + '/' + f));
const py = process.env.PYTHON ?? '/opt/homebrew/bin/python3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFile(path, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250))
    if (existsSync(path)) {
      await sleep(300);
      return JSON.parse(readFileSync(path, 'utf8'));
    }
  throw new Error('timeout ' + path);
}
const pids = () => {
  try {
    return execFileSync('/usr/bin/pgrep', ['-x', 'ghostty']).toString().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const load = () => execFileSync('/usr/sbin/sysctl', ['-n', 'vm.loadavg']).toString().trim();
async function ghostty(out) {
  const before = new Set(pids());
  execFileSync('/usr/bin/open', [
    '-na',
    '/Applications/Ghostty.app',
    '--args',
    '--config-default-files=false',
    '--font-family=JetBrainsMono Nerd Font',
    '--font-size=14',
    `--window-width=${process.env.COLS ?? 160}`,
    `--window-height=${process.env.ROWS ?? 50}`,
    '--window-padding-x=0',
    '--window-padding-y=0',
    '--confirm-close-surface=false',
    '-e',
    py,
    here + 'probe.py',
    out,
    String(reps),
    ...files,
  ]);
  try {
    return await waitFile(out, 30 * 60e3);
  } finally {
    for (const pid of pids()) if (!before.has(pid)) process.kill(Number(pid));
  }
}
async function wraith(out) {
  const port = Number(process.env.PORT ?? 7790);
  const serve = spawn(
    'node',
    [
      process.env.SERVE_BIN ??
        (process.env.SERVE_REPO ?? repo) + '/packages/wraith/bin/wraithterm.mjs',
      'serve',
      '--port',
      String(port),
      '--no-install',
      '--',
      py,
      here + 'probe.py',
      out,
      String(reps),
      ...files,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let text = '';
  const link = await new Promise((done) =>
    serve.stdout.on('data', (d) => {
      text += d;
      const m = text.match(/http:\/\/\S+token=\S+/);
      if (m) done(m[0]);
    }),
  );
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    args: ['--window-position=0,0', '--enable-unsafe-webgpu'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: Number(process.env.VW ?? 1356), height: Number(process.env.VH ?? 862) },
      deviceScaleFactor: 2,
    });
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    // Arrival times of output messages, as [ms, bytes] pairs.
    await page.addInitScript(() => {
      const Socket = window.WebSocket;
      window.__arrivals = [];
      window.WebSocket = class extends Socket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', (e) =>
            window.__arrivals.push([performance.now(), e.data.byteLength ?? e.data.length]),
          );
        }
      };
    });
    await page.goto(link);
    const result = await waitFile(out, 30 * 60e3);
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    result.arrival = arrivals(await page.evaluate(() => window.__arrivals), result.results);
    return result;
  } finally {
    await browser.close();
    serve.kill();
  }
}
// Splits the message log by each workload's size and reports the window in which
// its bytes arrived in the page, against the probe's total time.
function arrivals(log, results) {
  const out = [];
  let i = 0;
  for (const r of results) {
    while (i < log.length && log[i][1] < 4096) i++;
    let bytes = 0;
    const start = i;
    while (i < log.length && bytes < r.bytes * 0.99) bytes += log[i++][1];
    if (i === start) break;
    const ms = log[i - 1][0] - log[start][0];
    out.push({ file: r.file, messages: i - start, ms, totalMs: r.seconds * 1e3 });
  }
  return out;
}
const only = process.env.ONLY;
const runs = [];
for (let round = 0; round < rounds; round++) {
  const order = round % 2 ? ['wraith', 'ghostty'] : ['ghostty', 'wraith'];
  for (const name of order.filter((n) => !only || n === only)) {
    const out = `${process.env.TMPDIR ?? '/tmp/'}ghostty-native-${name}-${round}.json`;
    rmSync(out, { force: true });
    const loadBefore = load();
    const r = await (name === 'ghostty' ? ghostty(out) : wraith(out));
    runs.push({ name, round, loadBefore, loadAfter: load(), ...r });
    console.log(
      name,
      round,
      r.cols + 'x' + r.rows,
      r.results.map((x) => `${x.file} ${x.MBps.toFixed(1)} MB/s`).join(', '),
      r.arrival
        ? '| in page ' +
            r.arrival.map((a) => `${a.ms.toFixed(0)}/${a.totalMs.toFixed(0)} ms`).join(', ')
        : '',
    );
    await sleep(2000);
  }
}
writeFileSync(
  process.env.OUT ?? 'ghostty-native-runs.json',
  JSON.stringify(
    {
      ghostty: execFileSync('/Applications/Ghostty.app/Contents/MacOS/ghostty', ['--version'])
        .toString()
        .split('\n')[0],
      rounds,
      reps,
      files,
      runs,
    },
    null,
    1,
  ),
);
