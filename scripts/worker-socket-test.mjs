// Worker-owned sockets (`term.connect(url)`) through `wraithterm serve`: output
// order across a flood, replacement and reconnect, input while the parser is
// stalled, and open/close/error semantics, on both WebSocketStream and
// WebSocket-event transports.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const cli = resolve(import.meta.dirname, '../packages/wraith/bin/wraithterm.mjs');
// Every connection runs this: about 2 MB of numbered lines, a marker, then cat.
const LINES = 300000;
const script = `seq 1 ${LINES}; echo tail-marker; exec cat`;
const server = spawn(
  process.execPath,
  [cli, 'serve', '--port', '0', '--no-install', '--', '/bin/sh', '-c', script],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
const link = await new Promise((done, fail) => {
  server.stdout.on('data', (d) => {
    output += d;
    const match = output.match(/http:\/\/\S+token=\w+/);
    if (match) done(match[0]);
  });
  server.stderr.on('data', (d) => (output += d));
  server.on('exit', (code) => fail(new Error(`serve exited ${code}: ${output}`)));
  setTimeout(() => fail(new Error(`no URL: ${output}`)), 20000);
});
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 900, height: 500 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(link);
  await page.waitForFunction(() => window.wraith && window.wraithSocket);
  const read = () => page.evaluate(() => window.wraith.getText());
  const until = async (test, label, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(50))
      if (test(await read())) return;
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(await read())}`);
  };
  // Every visible numbered line follows its predecessor, ending at LINES.
  const ordered = (text) => {
    const lines = text.split('\n').map((l) => l.trim());
    const tail = lines.indexOf('tail-marker');
    assert(tail > 0, text);
    const numbers = lines.slice(0, tail).filter(Boolean).map(Number);
    assert(numbers.length > 5, text);
    numbers.forEach((n, i) => assert.equal(n, LINES - numbers.length + 1 + i, text));
  };
  await until((t) => t.includes('tail-marker'), 'first session output');
  ordered(await read());

  for (const stream of [true, false]) {
    const label = stream ? 'stream' : 'events';
    // Reconnecting replaces the previous worker socket, which reports a clean close.
    const replaced = await page.evaluate(async (stream) => {
      const previous = window.wraithSocket;
      await window.wraith.write('\x1b[2J\x1b[H');
      const next = window.wraith.connect('/pty' + location.search, { stream });
      const events = [];
      next.onOpen(() => events.push('open'));
      next.onClose(() => events.push('close'));
      window.wraithSocket = next;
      window.wraithEvents = events;
      await next.opened;
      return { closed: await previous.closed, transport: next.transport, events };
    }, stream);
    assert.equal(replaced.closed.wasClean, true, label);
    assert.equal(replaced.transport, label);
    assert.deepEqual(replaced.events, ['open']);

    // Stall the parser with a GPU benchmark mid-flood: output queued meanwhile
    // must still land complete and in order.
    await page.evaluate(() => window.wraith.benchmark({ frames: 400, workload: 'dense' }));
    await until((t) => t.includes('tail-marker'), `${label} flood`);
    ordered(await read());
    // Keys typed while the parser is stalled are sent after it resumes; cat's
    // echo follows the flood.
    await page.evaluate(() => {
      window.benchmarkDone = window.wraith.benchmark({ frames: 400, workload: 'dense' });
    });
    await page.keyboard.type(`typed-${label}`);
    await page.evaluate(() => window.benchmarkDone);
    await until((t) => t.includes(`typed-${label}`), `${label} typed echo`);
    const text = await read();
    assert(text.indexOf('tail-marker') < text.indexOf(`typed-${label}`), text);
    ordered(text.slice(0, text.indexOf(`typed-${label}`)));

    // send() is ordered with keystrokes: a resize request reaches the PTY.
    await page.evaluate(() =>
      window.wraithSocket.send(JSON.stringify({ type: 'resize', cols: 40, rows: 10 })),
    );
    await page.keyboard.press('Enter');

    // Client close: the close event follows and reports a clean close.
    const closed = await page.evaluate(async () => {
      window.wraithSocket.close(1000, 'bye');
      return { closed: await window.wraithSocket.closed, events: window.wraithEvents };
    });
    assert.equal(closed.closed.wasClean, true, label);
    assert.deepEqual(closed.events, ['open', 'close']);
    // Sending after close is a no-op, not an error.
    await page.evaluate(() => window.wraithSocket.send('ignored'));

    // A refused socket reports an error, rejects opened and closes uncleanly.
    const refused = await page.evaluate(async (stream) => {
      const socket = window.wraith.connect('/pty?token=wrong', { stream });
      let error = '';
      socket.onError((e) => (error = e.message));
      const opened = await socket.opened.then(
        () => 'opened',
        () => 'rejected',
      );
      return { opened, error, closed: await socket.closed };
    }, stream);
    assert.equal(refused.opened, 'rejected', label);
    assert(refused.error, label);
    assert.equal(refused.closed.wasClean, false, label);
  }

  // An unsupported scheme fails without breaking the terminal.
  const invalid = await page.evaluate(async () => {
    const socket = window.wraith.connect('ftp://127.0.0.1/');
    let error = '';
    socket.onError((e) => (error = e.message));
    return { closed: await socket.closed, error };
  });
  assert.equal(invalid.closed.code, 1006);
  assert(invalid.error);
  // The terminal still works afterwards: a fresh session streams in order.
  // A recorder started first captures the output parsed in the worker.
  await page.evaluate(async () => {
    await window.wraith.write('\x1b[2J\x1b[H');
    window.wraithRecorder = window.wraith.record();
    window.wraithSocket = window.wraith.connect('/pty' + location.search);
  });
  await until((t) => t.includes('tail-marker'), 'reconnected output');
  ordered(await read());
  const recorded = await page.evaluate(() => {
    const recording = window.wraithRecorder.stop();
    const decoder = new TextDecoder();
    const text = recording.events
      .filter((e) => e.type === 'output')
      .map((e) => decoder.decode(e.data, { stream: true }))
      .join('');
    return { head: text.slice(0, 32), tail: text.includes('tail-marker'), length: text.length };
  });
  assert(recorded.tail, `recording of worker-socket output: ${JSON.stringify(recorded)}`);
  assert.match(recorded.head, /^1\r?\n2\r?\n/);
  assert(recorded.length > 2_000_000, `recorded ${recorded.length} characters`);
  // Disposing the terminal resolves the open connection's closed promise.
  const disposed = await page.evaluate(async () => {
    await window.wraith.dispose();
    return window.wraithSocket.closed;
  });
  assert.equal(disposed.wasClean, false);
  assert.deepEqual(errors, []);
  console.log(
    'worker socket passed: ordered flood, replace and reconnect, input during a parser stall, send(), clean close, refused and invalid URLs, record(), dispose; stream and events transports.',
  );
} finally {
  await browser.close();
  server.kill('SIGINT');
}
