#!/usr/bin/env node
// wraithterm serve: run your shell in a native Wraith terminal in the browser.
// A local HTTP server serves the page and the SDK; a WebSocket carries PTY bytes.
// Binary messages are terminal input/output; text messages are JSON control.
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { spawnSync, spawn as spawnProcess } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
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
    else if (arg === '--no-install') options.install = false;
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

const page = (token) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wraith</title>
<link rel="stylesheet" href="/wraithterm/css/xterm.css" />
<script type="importmap">{"imports":{"@wraith-terminal/xterm-base/":"/xterm-base/"}}</script>
<style>html,body{margin:0;height:100%;background:#0c0806}#t{position:fixed;inset:6px}#e{position:fixed;inset:0;display:none;place-items:center;color:#f2e6da;font:14px ui-monospace,Menlo,monospace;white-space:pre-wrap;padding:24px}</style>
</head>
<body>
<div id="t"></div><div id="e"></div>
<script type="module">
import { Wraith } from '/wraithterm/dist/index.js';
const fail = (m) => { const e = document.getElementById('e'); e.style.display = 'grid'; e.textContent = m; };
try {
  const term = await Wraith.mount(document.getElementById('t'), {
    fontSize: 14,
    theme: { background: '#0c0806', foreground: '#f2e6da', cursor: '#ffb86b' },
  });
  window.wraith = term;
  term.onTitleChange((title) => (document.title = title || 'Wraith'));
  const socket = new WebSocket(\`\${location.protocol === 'https:' ? 'wss' : 'ws'}://\${location.host}/pty?token=${token}\`);
  socket.binaryType = 'arraybuffer';
  const size = () => socket.readyState === 1 && socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  socket.addEventListener('open', size);
  term.onResize(size);
  term.connect(socket);
  socket.addEventListener('close', () => term.write('\\r\\n\\x1b[2m[session ended]\\x1b[0m\\r\\n'));
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

// Minimal RFC 6455 server: unfragmented-or-fragmented frames, masking, ping/pong, close.
function accept(socket, key) {
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const handlers = { message: () => {}, close: () => {} };
  let buffer = Buffer.alloc(0),
    parts = [],
    partOpcode = 0,
    closed = false;
  // data is a Buffer or an array of Buffers sent as one message. Large payloads
  // go to the kernel in one writev beside the header instead of being copied.
  // done runs once the socket has taken the message (at once if closed).
  const send = (opcode, data, done) => {
    if (closed) return done?.();
    const parts = Array.isArray(data) ? data : [data];
    let length = 0;
    for (const part of parts) length += part.length;
    const head =
      length < 126
        ? Buffer.from([0x80 | opcode, length])
        : length < 65536
          ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
          : Buffer.concat([
              Buffer.from([0x80 | opcode, 127]),
              (() => {
                const b = Buffer.alloc(8);
                b.writeBigUInt64BE(BigInt(length));
                return b;
              })(),
            ]);
    if (length < 16384) {
      socket.write(Buffer.concat([head, ...parts], head.length + length), done);
      return;
    }
    socket.cork();
    socket.write(head);
    for (let i = 0; i < parts.length; i++)
      socket.write(parts[i], i === parts.length - 1 ? done : undefined);
    socket.uncork();
  };
  const close = () => {
    if (closed) return;
    send(8, Buffer.alloc(0));
    closed = true;
    socket.end();
    handlers.close();
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = buffer[0] & 0x80,
        opcode = buffer[0] & 15,
        masked = buffer[1] & 0x80;
      let length = buffer[1] & 127,
        offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (!masked || length > 64 << 20) return close();
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 8) return close();
      if (opcode === 9) send(10, data);
      else if (opcode === 1 || opcode === 2 || opcode === 0) {
        if (opcode) partOpcode = opcode;
        parts.push(data);
        if (fin) {
          handlers.message(Buffer.concat(parts), partOpcode === 2);
          parts = [];
        }
      }
    }
  });
  socket.on('close', () => {
    closed = true;
    handlers.close();
  });
  socket.on('error', () => socket.destroy());
  return {
    on: (event, fn) => (handlers[event] = fn),
    send: (data, binary, done) =>
      send(
        binary ? 2 : 1,
        Buffer.isBuffer(data) || Array.isArray(data) ? data : Buffer.from(data),
        done,
      ),
    close,
    closed: () => closed,
    buffered: () => socket.writableLength,
    onDrain: (fn) => socket.on('drain', fn),
  };
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
const WAKE = 0,
  HEAD = 1,
  TAIL = 2,
  BELL = 3;
const READER = `
Error.stackTraceLimit = 0;
const { parentPort, workerData: { fd, control, ring } } = require('node:worker_threads');
const { readSync } = require('node:fs');
const state = new Int32Array(control), buf = Buffer.from(ring), size = buf.length;
let head = 0, idle = 0, lastData = 0, woken = 0;
for (;;) {
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
parentPort.postMessage(null);
`;
// Output is sent as it is read at the start of a burst, keeping echo immediate,
// then batched every 2 ms into messages of up to the whole ring. sink.send(parts,
// done) sends one message and calls done once the socket has taken it.
function readPty(term, sink) {
  // Unix PTYs only; Windows (ConPTY) keeps node-pty's own reader.
  if (platform() === 'win32' || typeof term._fd !== 'number' || !term._socket?.pause)
    return undefined;
  const control = new SharedArrayBuffer(16),
    ring = new SharedArrayBuffer(RING);
  const state = new Int32Array(control);
  let sent = 0,
    released = 0,
    timer,
    lastSend = 0,
    ended = false;
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
  term._socket.pause();
  // node-pty's socket starts reading on the next tick even while paused; stop
  // it, send what it already read, then hand the master to the reader thread.
  setImmediate(() => {
    term._socket._handle?.readStop();
    for (let early; (early = term._socket.read()) !== null;) sink.send([early], () => {});
    const worker = new Worker(READER, {
      eval: true,
      workerData: { fd: term._fd, control, ring },
    });
    worker.unref();
    worker.on('message', (data) => {
      if (data === null) {
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
    worker.on('error', () => term._socket.destroy());
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
  const token = randomBytes(24).toString('hex');
  const tokenBuffer = Buffer.from(token);
  const okToken = (value) => {
    const b = Buffer.from(String(value ?? ''));
    return b.length === tokenBuffer.length && timingSafeEqual(b, tokenBuffer);
  };
  const xtermBase = dirname(require.resolve('@wraith-terminal/xterm-base/package.json'));
  const shell = options.command.length
    ? options.command
    : [process.env.SHELL || (platform() === 'win32' ? 'powershell.exe' : '/bin/sh')];
  const sessions = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const path = decodeURIComponent(url.pathname);
    if (path === '/') {
      if (!okToken(url.searchParams.get('token'))) {
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
        .end(page(token));
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
    const url = new URL(req.url, 'http://local');
    // Only this page may connect: right path, token and same-origin browser.
    const origin = req.headers.origin;
    const sameOrigin = !origin || new URL(origin).host === req.headers.host;
    if (
      url.pathname !== '/pty' ||
      !okToken(url.searchParams.get('token')) ||
      !sameOrigin ||
      req.headers.upgrade?.toLowerCase() !== 'websocket'
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    socket.setNoDelay(true);
    const ws = accept(socket, req.headers['sec-websocket-key']);
    const term = pty.spawn(shell[0], shell.slice(1), {
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
          term.resize(Math.min(512, message.cols | 0), Math.min(512, message.rows | 0));
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
  const link = `http://${host === '0.0.0.0' || host === '[::]' ? 'localhost' : host}:${port}/?token=${token}`;
  if (!['127.0.0.1', 'localhost', '::1'].includes(options.host))
    console.warn(
      `\nWarning: bound to ${options.host}. Anyone who can reach this port and has the URL gets a shell as you.\n`,
    );
  console.log(
    `Wraith is serving ${shell.join(' ')} at:\n\n  ${link}\n\nOpen it in a WebGPU browser. Press Ctrl-C to stop.`,
  );
  if (options.open) {
    const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
    spawnProcess(opener, [link], {
      stdio: 'ignore',
      detached: true,
      shell: platform() === 'win32',
    }).unref();
  }
  const stop = () => {
    for (const term of sessions) term.kill();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { server, link, token, port };
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
