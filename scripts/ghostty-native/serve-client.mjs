// serve's own capacity, without a browser: `wraithterm serve` runs probe.py and a
// Node WebSocket client answers its cursor-position queries. Prints MB/s per
// workload and serve's CPU time and RSS at the end.
// PORT=6221 SERVE_BIN=… node scripts/ghostty-native/serve-client.mjs a.ansi b.ansi
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const repo = new URL('../..', import.meta.url).pathname;
const here = new URL('.', import.meta.url).pathname;
const port = process.env.PORT ?? '7790';
const files = process.argv.slice(2);
const out = join(tmpdir(), `serve-client-${process.pid}.json`);
const serve = spawn(
  'node',
  [
    process.env.SERVE_BIN ?? repo + 'packages/wraith/bin/wraithterm.mjs',
    'serve',
    '--port',
    port,
    '--no-install',
    '--',
    process.env.PYTHON ?? '/opt/homebrew/bin/python3',
    here + 'probe.py',
    out,
    '1',
    ...files,
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
let text = '';
const token = await new Promise((done) =>
  serve.stdout.on('data', (d) => {
    text += d;
    const m = text.match(/token=(\S+)/);
    if (m) done(m[1]);
  }),
);
const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?token=${token}`);
ws.binaryType = 'arraybuffer';
const reply = new TextEncoder().encode('\x1b[50;1R');
let tail = '',
  messages = 0,
  bytes = 0;
ws.onopen = () => ws.send(JSON.stringify({ type: 'resize', cols: 160, rows: 50 }));
ws.onmessage = (e) => {
  const u = new Uint8Array(e.data);
  messages++;
  bytes += u.length;
  // Count CSI 6 n queries, including one split across messages.
  const s = tail + Buffer.from(u).toString('latin1');
  for (let i = s.indexOf('\x1b[6n'); i >= 0; i = s.indexOf('\x1b[6n', i + 1)) ws.send(reply);
  tail = s.slice(-3);
};
while (!existsSync(out)) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 200));
const result = JSON.parse(readFileSync(out, 'utf8'));
rmSync(out, { force: true });
const [cpu, rss] = execFileSync('/bin/ps', ['-o', 'time=,rss=', '-p', String(serve.pid)])
  .toString()
  .trim()
  .split(/\s+/);
console.log(
  JSON.stringify({
    load: execFileSync('/usr/sbin/sysctl', ['-n', 'vm.loadavg']).toString().trim(),
    serveCpuTime: cpu,
    serveRssMB: Math.round(Number(rss) / 1024),
    messages,
    bytes,
    results: result.results.map((x) => [x.file, +x.MBps.toFixed(1)]),
  }),
);
ws.close();
serve.kill();
process.exit(0);
