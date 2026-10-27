// End to end: `wraithterm serve` runs a command in a PTY, the page renders it in
// native Wraith, resize reaches the PTY, and wrong tokens are refused.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const cli = resolve(import.meta.dirname, '../packages/wraith/bin/wraithterm.mjs');
const script =
  'echo serve-marker-$((6*7)); echo "term=$TERM program=$TERM_PROGRAM"; sleep 1.5; echo "cols=$(tput cols) rows=$(tput lines)"; exec cat';
const server = spawn(
  process.execPath,
  [cli, 'serve', '--port', '0', '--no-install', '--', '/bin/sh', '-c', script],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
  },
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
  const base = new URL(link);
  // Wrong or missing tokens: the page and the PTY socket are refused.
  assert.equal((await fetch(`${base.origin}/`)).status, 403);
  assert.equal((await fetch(`${base.origin}/?token=nope`)).status, 403);
  const socketRefused = await new Promise((done) => {
    const ws = new WebSocket(`ws://${base.host}/pty?token=nope`);
    ws.onopen = () => done(false);
    ws.onerror = () => done(true);
  });
  assert(socketRefused, 'WebSocket with a wrong token is refused');

  // The default page lets the worker own the socket; ?transport=page bridges a
  // page-owned WebSocket. Each load spawns its own PTY session.
  for (const transport of ['worker', 'page']) {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 600 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(transport === 'page' ? `${link}&transport=page` : link);
    await page.waitForFunction(() => document.querySelector('#t canvas'), null, { timeout: 15000 });
    await page.waitForFunction(() => window.wraith);
    const read = () => page.evaluate(() => window.wraith.getText());
    // Poll from Node: waitForFunction does not await async predicates.
    const until = async (test, label) => {
      for (const end = Date.now() + 15000; Date.now() < end; await page.waitForTimeout(100))
        if (test(await read())) return;
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(await read())}`);
    };
    await until((t) => /cols=\d+/.test(t), 'tput output');
    if (transport === 'worker')
      assert.equal(await page.evaluate(() => window.wraithSocket.transport), 'stream');
    await page.keyboard.type('typed-through-pty');
    await page.keyboard.press('Enter');
    await until((t) => t.split('typed-through-pty').length > 2, 'echo from cat');
    const screen = await read();
    const cols = await page.evaluate(() => [window.wraith.cols, window.wraith.rows]);
    assert.match(screen, /serve-marker-42/);
    assert.match(screen, /term=xterm-256color program=wraith/);
    // The page sent its fitted size; the PTY reports the same grid.
    assert.match(screen, new RegExp(`cols=${cols[0]} rows=${cols[1]}`));
    const shot = await page.screenshot();
    assert(shot.length > 10000, 'rendered pixels');
    // End the session: cat echoes the last line, then exits on Ctrl-D. The
    // notice must follow every byte of output.
    await page.keyboard.type('last-line');
    await page.keyboard.press('Enter');
    await until((t) => t.split('last-line').length > 2, 'last line echoed');
    await page.keyboard.press('Control+D');
    await until((t) => t.includes('[session ended]'), 'session ended notice');
    const final = await read();
    assert(final.lastIndexOf('last-line') < final.indexOf('[session ended]'), final);
    if (transport === 'worker') {
      const closed = await page.evaluate(() => window.wraithSocket.closed);
      assert.equal(closed.wasClean, true);
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `serve (${transport} socket) passed: PTY output, TERM/TERM_PROGRAM, ${cols[0]}x${cols[1]} resize round-trip, typed input echoed, [session ended] after the final output.`,
    );
  }
  console.log('serve passed: wrong-token page and socket refused.');
} finally {
  await browser.close();
  server.kill('SIGINT');
}
