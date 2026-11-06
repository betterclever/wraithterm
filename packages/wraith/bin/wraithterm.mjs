#!/usr/bin/env node
// wraithterm serve: run your shell in a native Wraith terminal in the browser.
// A local HTTP server serves the page and the SDK; a WebSocket carries PTY bytes.
// Binary messages are terminal input/output; text messages are JSON control.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { spawnSync, spawn as spawnProcess } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket, clampSize, createShare } from '../share/index.mjs';
import { Worker } from 'node:worker_threads';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const PTY_VERSION = '1.1.0';

const usage = `wraithterm ${version}

Usage: wraithterm serve [options] [-- command [args...]]

Run your shell (or a command) in a native Wraith terminal in your browser.

Options:
  --port <n>     Port to listen on (default 7681; 0 picks a free port)
  --host <addr>  Interface to bind (default 127.0.0.1). Anything else exposes a
                 shell to your network; the URL token is the only protection.
  --share        Share one PTY: also print a read-only viewer link
  --share=write  Also print a collaborator link that can type (not resize)
  --record <f>   Write an asciicast v2 recording of the session to <f>
                 (output and resizes; input is not recorded)
  --open         Open the URL in your default browser
  --no-install   Do not offer to install the PTY module (node-pty)
  -h, --help     Show this help
`;

function parse(argv) {
  const options = { port: 7681, host: '127.0.0.1', open: false, install: true, command: [] };
  const rest = argv.indexOf('--');
  if (rest >= 0) {
    options.command = argv.slice(rest + 1);
    argv = argv.slice(0, rest);
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--host') options.host = argv[++i];
    else if (arg === '--open') options.open = true;
    else if (arg === '--share') options.share = 'read';
    else if (arg === '--share=write' || arg === '--share=read')
      options.share = arg.slice('--share='.length);
    else if (arg === '--record' || arg.startsWith('--record=')) {
      options.record = arg === '--record' ? argv[++i] : arg.slice('--record='.length);
      if (!options.record) throw new Error('--record needs a file path');
    } else if (arg === '--no-install') options.install = false;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error('--port must be 0..65535');
  return options;
}

// node-pty is a native module; keep it out of library installs and load it from
// the project, a global install or Wraith's own cache.
const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'wraithterm', 'pty');
function loadPty() {
  for (const from of [
    join(process.cwd(), 'package.json'),
    join(root, 'package.json'),
    join(cache, 'package.json'),
  ]) {
    try {
      const path = createRequire(from).resolve('node-pty');
      // node-pty 1.1's macOS prebuild can lose the helper's execute bit.
      const prebuilds = join(dirname(path), '..', 'prebuilds');
      if (existsSync(prebuilds))
        for (const dir of readdirSync(prebuilds)) {
          const helper = join(prebuilds, dir, 'spawn-helper');
          if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
        }
      return createRequire(from)('node-pty');
    } catch {}
  }
  return undefined;
}
async function ensurePty(install) {
  const pty = loadPty();
  if (pty) return pty;
  const hint = `Install it with: npm install -g node-pty@${PTY_VERSION}`;
  if (!install || !process.stdin.isTTY) throw new Error(`wraithterm serve needs node-pty. ${hint}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question(
      `wraithterm serve needs node-pty (a native PTY module). Install it into ${cache}? [Y/n] `,
    )
  ).trim();
  rl.close();
  if (answer && !/^y(es)?$/i.test(answer)) throw new Error(hint);
  mkdirSync(cache, { recursive: true });
  const npm = platform() === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    [
      'install',
      '--prefix',
      cache,
      '--no-save',
      '--no-audit',
      '--no-fund',
      `node-pty@${PTY_VERSION}`,
    ],
    {
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) throw new Error(`Could not install node-pty. ${hint}`);
  const loaded = loadPty();
  if (!loaded) throw new Error(`node-pty installed but could not be loaded. ${hint}`);
  return loaded;
}

// Single-client pages connect the terminal straight to the socket. Shared pages
// join with Wraith.join(), which follows the owner's grid for guests and
// carries the control messages (hello, size, presence, reset).
const page = (token, role = 'owner', shared = false) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wraith</title>
<link rel="stylesheet" href="/wraithterm/css/xterm.css" />
<script type="importmap">{"imports":{"@wraith-terminal/xterm-base/":"/xterm-base/"}}</script>
<style>html,body{margin:0;height:100%;background:#0c0806;overflow:hidden}#t{position:fixed;inset:6px}#e{position:fixed;inset:0;display:none;place-items:center;color:#f2e6da;font:14px ui-monospace,Menlo,monospace;white-space:pre-wrap;padding:24px}#p{position:fixed;top:8px;right:10px;z-index:2;display:none;padding:3px 9px;border-radius:999px;background:rgba(242,230,218,.1);color:#f2e6da;font:11px/16px ui-monospace,Menlo,monospace;opacity:.75;pointer-events:none}#p b{color:#ffb86b;font-weight:normal}</style>
</head>
<body>
<div id="t"></div><div id="e"></div><div id="p" role="status" aria-live="polite"></div>
<script type="module">
import { Wraith } from '/wraithterm/dist/index.js';
const shared = ${shared};
const fail = (m) => { const e = document.getElementById('e'); e.style.display = 'grid'; e.textContent = m; };
try {
  const host = document.getElementById('t');
  const options = { fontSize: 14, theme: { background: '#0c0806', foreground: '#f2e6da', cursor: '#ffb86b' } };
  const url = '/pty?token=${token}';
  let term;
  if (shared) {
    const session = await Wraith.join(host, url, options);
    term = session.terminal;
    window.wraithShare = session;
    const badge = document.getElementById('p');
    const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
    session.onPresence((p) => {
      const counts = [];
      if (p.owners) counts.push(plural(p.owners, 'owner'));
      if (p.collaborators) counts.push(plural(p.collaborators, 'collaborator'));
      if (p.viewers) counts.push(plural(p.viewers, 'viewer'));
      if (p.lagging) counts.push(p.lagging + ' resyncing');
      const label = session.role === 'owner' ? 'shared' : session.role === 'viewer' ? 'view only' : 'collaborating';
      badge.textContent = '';
      const dot = document.createElement('b');
      dot.textContent = '\\u25cf ';
      badge.append(dot, label + ' \\u00b7 ' + counts.join(' \\u00b7 '));
      badge.style.display = 'block';
    });
    session.closed.then(() => term.write('\\r\\n\\x1b[2m[session ended]\\x1b[0m\\r\\n'));
  } else {
    term = await Wraith.mount(host, { ...options, fit: true });
    const ended = () => term.write('\\r\\n\\x1b[2m[session ended]\\x1b[0m\\r\\n');
    if (new URLSearchParams(location.search).get('transport') === 'page') {
      // Otherwise the worker owns the socket: PTY output is parsed without
      // touching this thread. ?transport=page keeps a page-owned socket to compare.
      const socket = new WebSocket(new URL(url, location.href.replace(/^http/, 'ws')));
      socket.binaryType = 'arraybuffer';
      const size = () => socket.readyState === 1 && socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      socket.addEventListener('open', size);
      term.onResize(size);
      term.connect(socket);
      socket.addEventListener('close', ended);
    } else {
      const socket = term.connect(url);
      window.wraithSocket = socket;
      // Sent once open, ordered with keystrokes.
      const size = () => socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      size();
      term.onResize(size);
      // A failed or disposed terminal also resolves closed; it cannot be written.
      socket.closed.then(ended).catch(() => {});
    }
  }
  window.wraith = term;
  term.onTitleChange((title) => (document.title = title || 'Wraith'));
  term.focus();
} catch (error) {
  fail(String(error.message ?? error));
}
</script>
</body>
</html>`;

const types = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};
function serveFile(res, base, rel) {
  const file = normalize(join(base, rel));
  if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(readFileSync(file));
}

// node-pty reads a Unix PTY on the event loop, one 1 KiB read per turn: about
// 95 MB/s on macOS. Instead a thread polls the non-blocking master and reads
// straight into a shared ring buffer, which the main thread hands to the socket
// as views: no copies or allocations between the PTY and the kernel. Every empty
// poll throws EAGAIN, and a stack trace for each capped the thread near 190 MB/s,
// so traces are off. After output stops the thread spins for 0.2 ms, then sleeps
// with backoff up to 4 ms, or 16 ms once idle; input wakes it at once. A full
// ring (the socket is backed up) blocks the thread and so the PTY.
const RING = 4 << 20;
// Shared Int32 slots: input wakes, bytes written by the reader (head), bytes
// released by the main thread (tail), and the doorbell (1 while the main
// thread has been told data is waiting). Counters wrap; differences do not.
// STOP asks the thread to exit and DONE says it has.
const WAKE = 0,
  HEAD = 1,
  TAIL = 2,
  BELL = 3,
  STOP = 4,
  DONE = 5;
const READER = `
Error.stackTraceLimit = 0;
const { parentPort, workerData: { fd, control, ring } } = require('node:worker_threads');
const { readSync } = require('node:fs');
const state = new Int32Array(control), buf = Buffer.from(ring), size = buf.length;
let head = 0, idle = 0, lastData = 0, woken = 0;
while (!Atomics.load(state, ${STOP})) {
  const tail = Atomics.load(state, ${TAIL}), free = size - ((head - tail) | 0);
  if (!free) {
    Atomics.wait(state, ${TAIL}, tail, 100);
    continue;
  }
  const wake = Atomics.load(state, ${WAKE});
  // Input was written: its echo is due, so poll eagerly again.
  if (wake !== woken) {
    woken = wake;
    idle = 0;
  }
  const at = head & (size - 1);
  let n;
  try {
    n = readSync(fd, buf, at, Math.min(free, size - at, 65536), null);
  } catch (error) {
    if (error.code !== 'EAGAIN') break;
    n = -1;
  }
  if (n === 0) break;
  const now = performance.now();
  if (n > 0) {
    head = (head + n) | 0;
    Atomics.store(state, ${HEAD}, head);
    if (Atomics.compareExchange(state, ${BELL}, 0, 1) === 0) parentPort.postMessage(0);
    idle = 0;
    lastData = now;
  } else if (now - lastData > 0.2)
    Atomics.wait(state, ${WAKE}, wake, Math.min(now - lastData > 250 ? 16 : 4, 0.05 * 2 ** idle++));
}
Atomics.store(state, ${DONE}, 1);
Atomics.notify(state, ${DONE});
parentPort.postMessage(null);
`;
// Output is sent as it is read at the start of a burst, keeping echo immediate,
// then batched every 2 ms into messages of up to the whole ring. sink.send(parts,
// done) sends one message and calls done once the socket has taken it.
function readPty(term, sink) {
  // Unix PTYs only; Windows (ConPTY) keeps node-pty's own reader.
  if (platform() === 'win32' || typeof term._fd !== 'number' || !term._socket?.pause)
    return undefined;
  const control = new SharedArrayBuffer(24),
    ring = new SharedArrayBuffer(RING);
  const state = new Int32Array(control);
  let sent = 0,
    released = 0,
    timer,
    lastSend = 0,
    ended = false,
    running = false;
  const drain = (force) => {
    clearTimeout(timer);
    timer = undefined;
    const length = (Atomics.load(state, HEAD) - sent) | 0;
    if (!length) {
      // Idle: ask to be told about the next byte, then recheck for a race.
      Atomics.store(state, BELL, 0);
      if (Atomics.load(state, HEAD) !== sent) timer = setTimeout(drain, 2);
      return;
    }
    // Backed up: leave the bytes in the ring until the socket drains.
    if (!force && sink.blocked()) return;
    const at = sent & (RING - 1),
      first = Math.min(length, RING - at);
    const parts = [Buffer.from(ring, at, first)];
    if (length > first) parts.push(Buffer.from(ring, 0, length - first));
    sent = (sent + length) | 0;
    lastSend = performance.now();
    sink.send(parts, () => {
      released = (released + length) | 0;
      Atomics.store(state, TAIL, released);
      Atomics.notify(state, TAIL);
    });
    if (!ended) timer = setTimeout(drain, 2);
  };
  sink.onDrain(() => !ended && !timer && drain());
  // node-pty closes the master when its socket is destroyed, including 200 ms
  // after the child exits while another process still holds the slave open (on
  // Linux the master then never reads EIO). A thread still polling that fd
  // number would read whichever file reuses it, such as the next session's PTY.
  // So the thread stops before the fd closes, and what it read is sent first.
  const socket = term._socket,
    destroy = socket._destroy;
  socket._destroy = function (error, callback) {
    if (running) {
      running = false;
      Atomics.store(state, STOP, 1);
      Atomics.notify(state, WAKE);
      Atomics.notify(state, TAIL);
      // The thread never blocks in read(), so it stops within one poll.
      Atomics.wait(state, DONE, 0, 1000);
    }
    ended = true;
    drain(true);
    return destroy.call(this, error, callback);
  };
  socket.pause();
  // node-pty's socket starts reading on the next tick even while paused; stop
  // it, send what it already read, then hand the master to the reader thread.
  setImmediate(() => {
    if (socket.destroyed) return;
    term._socket._handle?.readStop();
    for (let early; (early = term._socket.read()) !== null;) sink.send([early], () => {});
    const worker = new Worker(READER, {
      eval: true,
      workerData: { fd: term._fd, control, ring },
    });
    running = true;
    worker.unref();
    worker.on('message', (data) => {
      if (data === null) {
        running = false;
        // EOF or EIO: send the rest, then close node-pty's socket so its exit
        // event fires.
        ended = true;
        drain(true);
        term._socket.destroy();
      } else if (!timer) {
        if (performance.now() - lastSend > 5) drain();
        else timer = setTimeout(drain, 2);
      }
    });
    worker.on('error', () => {
      running = false;
      term._socket.destroy();
    });
  });
  return {
    wake: () => {
      Atomics.add(state, WAKE, 1);
      Atomics.notify(state, WAKE);
    },
    // The socket closed: release whatever is queued so the thread reads on to EOF.
    close: () => drain(true),
  };
}

async function serve(options) {
  const pty = await ensurePty(options.install);
  const shared = Boolean(options.share || options.record);
  // Unshared tabs each get a PTY behind one owner token; a shared session's
  // tokens come from createShare. Both compare tokens in constant time.
  const ownerToken = randomBytes(24).toString('hex');
  const ownerOnly = (value) => {
    const given = Buffer.from(String(value ?? '')),
      expected = Buffer.from(ownerToken);
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? 'owner'
      : undefined;
  };
  const xtermBase = dirname(require.resolve('@wraith-terminal/xterm-base/package.json'));
  const shell = options.command.length
    ? options.command
    : [process.env.SHELL || (platform() === 'win32' ? 'powershell.exe' : '/bin/sh')];
  const spawnTerm = () =>
    pty.spawn(shell[0], shell.slice(1), {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      encoding: null,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'wraith',
        TERM_PROGRAM_VERSION: version,
      },
    });
  const sessions = new Set();
  let stopping = false;
  let share;
  if (shared) {
    const term = spawnTerm();
    sessions.add(term);
    share = createShare({
      pty: term,
      roles:
        options.share === 'write' ? ['collaborator', 'viewer'] : options.share ? ['viewer'] : [],
      record: options.record,
    });
    share.onExit(({ exitCode }) => {
      console.log('The shared command exited; stopping.');
      stop(exitCode ?? 0);
    });
  }
  const tokens = share?.tokens ?? { owner: ownerToken };
  const roleFor = share ? share.roleFor : ownerOnly;
  const server = createServer((req, res) => {
    // Malformed input from anyone who can reach the port must not stop the
    // server, which in shared mode would end the session for every client.
    let url, path;
    try {
      url = new URL(req.url, 'http://local');
      path = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path === '/') {
      const role = roleFor(url.searchParams.get('token'));
      if (!role) {
        res
          .writeHead(403, { 'content-type': 'text/plain' })
          .end('Missing or wrong token. Use the URL printed by wraithterm serve.\n');
        return;
      }
      res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        .end(page(tokens[role], role, shared));
      return;
    }
    for (const dir of ['dist', 'wasm', 'css'])
      if (path.startsWith(`/wraithterm/${dir}/`))
        return serveFile(res, join(root, dir), path.slice(`/wraithterm/${dir}/`.length));
    if (path.startsWith('/xterm-base/'))
      return serveFile(res, xtermBase, path.slice('/xterm-base/'.length));
    if (path === '/favicon.ico') return res.writeHead(204).end();
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket) => {
    // Only this page may connect: right path, token and same-origin browser.
    // `Origin: null` or a malformed URL is refused, never thrown.
    const tryUrl = (value, base) => {
      try {
        return new URL(value, base);
      } catch {}
    };
    const url = tryUrl(req.url, 'http://local');
    const origin = req.headers.origin;
    const sameOrigin = !origin || tryUrl(origin)?.host === req.headers.host;
    if (!url) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const role = roleFor(url.searchParams.get('token'));
    if (
      url.pathname !== '/pty' ||
      !role ||
      !sameOrigin ||
      req.headers.upgrade?.toLowerCase() !== 'websocket'
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (share) return void share.handleUpgrade(req, socket, { role });
    socket.setNoDelay(true);
    const ws = acceptWebSocket(socket, req.headers['sec-websocket-key']);
    const term = spawnTerm();
    sessions.add(term);
    // Where node-pty reads the PTY (Windows), it delivers output 1 KiB per
    // event-loop turn. Sending each read as its own message caps output near
    // 40 MB/s, so after the first chunk of a burst (sent at once, keeping echo
    // immediate) output is batched for 2 ms. The PTY pauses while the socket is
    // backed up instead of buffering unboundedly.
    let pending = [],
      pendingBytes = 0,
      timer,
      lastFlush = 0,
      paused = false;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      lastFlush = performance.now();
      if (!pending.length) return;
      ws.send(pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes), true);
      pending = [];
      pendingBytes = 0;
      if (!paused && ws.buffered() > 4 << 20) {
        paused = true;
        term.pause();
      }
    };
    ws.onDrain(() => {
      if (paused) {
        paused = false;
        term.resume();
      }
    });
    const output = (data) => {
      pending.push(Buffer.from(data));
      pendingBytes += data.length;
      if (pendingBytes >= 1 << 20 || (!timer && performance.now() - lastFlush > 5)) flush();
      else timer ??= setTimeout(flush, 2);
    };
    const reader = readPty(term, {
      send: (parts, done) => ws.send(parts, true, done),
      blocked: () => !ws.closed() && ws.buffered() > 4 << 20,
      onDrain: (fn) => ws.onDrain(fn),
    });
    if (!reader) term.onData(output);
    term.onExit(() => {
      flush();
      sessions.delete(term);
      ws.close();
    });
    ws.on('message', (data, binary) => {
      if (binary) {
        term.write(data);
        return reader?.wake();
      }
      try {
        const message = JSON.parse(data.toString('utf8'));
        if (message.type === 'resize' && message.cols > 0 && message.rows > 0)
          term.resize(clampSize(message.cols), clampSize(message.rows));
      } catch {}
    });
    ws.on('close', () => {
      reader?.close();
      if (sessions.has(term)) {
        sessions.delete(term);
        term.kill();
      }
    });
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(options.port, options.host, done);
  });
  const { port } = server.address();
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  const origin = `http://${host === '0.0.0.0' || host === '[::]' ? 'localhost' : host}:${port}`;
  const link = `${origin}/?token=${tokens.owner}`;
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(options.host);
  if (!loopback)
    console.warn(
      `\nWarning: bound to ${options.host}. Anyone who can reach this port and has the URL gets a shell as you.\n`,
    );
  let banner = `Wraith is serving ${shell.join(' ')} at:\n\n  ${link}\n`;
  if (shared) {
    banner = `Wraith is sharing ${shell.join(' ')}.\n\n  Owner (types, sets the size):\n  ${link}\n`;
    if (tokens.collaborator)
      banner += `\n  Collaborator (can type):\n  ${origin}/?token=${tokens.collaborator}\n`;
    if (tokens.viewer) banner += `\n  Viewer (read-only):\n  ${origin}/?token=${tokens.viewer}\n`;
    if (options.record) banner += `\n  Recording to ${options.record}\n`;
    if (options.share && loopback)
      banner +=
        '\n  Links work on this machine. For others, forward the port (ssh -L) or put it behind\n  HTTPS: WebGPU needs a secure context, which plain http:// on a LAN address is not.\n';
  }
  console.log(`${banner}\nOpen it in a WebGPU browser. Press Ctrl-C to stop.`);
  if (options.open) {
    const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
    spawnProcess(opener, [link], {
      stdio: 'ignore',
      detached: true,
      shell: platform() === 'win32',
    }).unref();
  }
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  return { server, link, tokens, port };
  // A declaration, so a shared command that exits early can already call it.
  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const term of sessions)
      try {
        term.kill();
      } catch {}
    await share?.close();
    server?.close();
    process.exit(code);
  }
}

const [command, ...argv] = process.argv.slice(2);
try {
  if (!command || command === '-h' || command === '--help') console.log(usage);
  else if (command === '--version' || command === '-v') console.log(version);
  else if (command === 'serve') {
    const options = parse(argv);
    if (options.help) console.log(usage);
    else await serve(options);
  } else throw new Error(`Unknown command: ${command}\n\n${usage}`);
} catch (error) {
  console.error(`wraithterm: ${error.message ?? error}`);
  process.exit(1);
}
