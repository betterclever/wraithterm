// Helpers shared by the `wraithterm serve` browser test and share benchmark.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { resolve } from 'node:path';

const cli = resolve(import.meta.dirname, '../packages/wraith/bin/wraithterm.mjs');

export function startServer(args, script) {
  const server = spawn(
    process.execPath,
    [cli, 'serve', '--port', '0', '--no-install', ...args, '--', '/bin/sh', '-c', script],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  const exited = new Promise((done) => server.on('exit', (code) => done(code)));
  const ready = new Promise((done, fail) => {
    server.stdout.on('data', (d) => {
      output += d;
      if (/Press Ctrl-C/.test(output))
        done({ links: output.match(/http:\/\/\S+token=\w+/g), output });
    });
    server.stderr.on('data', (d) => (output += d));
    server.on('exit', (code) => fail(new Error(`serve exited ${code}: ${output}`)));
    setTimeout(() => fail(new Error(`no URL: ${output}`)), 20000);
  });
  return { server, ready, exited };
}

export const launch = () =>
  chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
    headless: true,
  });
/** Open a serve page; `read()` returns its text and `until()` polls it. */
export async function open(browser, errors, link, viewport = { width: 1000, height: 600 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(link);
  await page.waitForFunction(() => document.querySelector('#t canvas'), null, { timeout: 15000 });
  await page.waitForFunction(() => window.wraith);
  const read = () => page.evaluate(() => window.wraith.getText());
  // Poll from Node: waitForFunction does not await async predicates.
  const until = async (test, label, timeout = 15000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(50))
      if (test(await read())) return;
    throw new Error(
      `timed out waiting for ${label}: ${JSON.stringify((await read()).slice(-400))}`,
    );
  };
  const grid = () => page.evaluate(() => [window.wraith.cols, window.wraith.rows]);
  return { page, read, until, grid };
}

// A minimal WebSocket client over a raw TCP socket so a test can stop reading.
export function rawClient(link) {
  const url = new URL(link);
  const socket = connect(Number(url.port), url.hostname);
  const key = randomBytes(16).toString('base64');
  socket.write(
    `GET /pty?token=${url.searchParams.get('token')} HTTP/1.1\r\nHost: ${url.host}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  let buffer = Buffer.alloc(0),
    upgraded = false;
  const messages = [];
  const listeners = new Set();
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      assert.match(buffer.subarray(0, end).toString(), /^HTTP\/1.1 101/);
      upgraded = true;
      buffer = buffer.subarray(end + 4);
    }
    while (buffer.length >= 2) {
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
      if (buffer.length < offset + length) return;
      const opcode = buffer[0] & 15;
      const data = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      const message = opcode === 1 ? JSON.parse(data.toString()) : data;
      messages.push(message);
      for (const fn of listeners) fn(message);
    }
  });
  const send = (data, opcode) => {
    const mask = randomBytes(4);
    const body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    socket.write(Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | body.length]), mask, body]));
  };
  return {
    socket,
    messages,
    onMessage: (fn) => listeners.add(fn),
    sendBinary: (text) => send(text, 2),
    sendText: (text) => send(text, 1),
    received: () => Buffer.concat(messages.filter((m) => Buffer.isBuffer(m))).toString('latin1'),
  };
}

export const wait = (ms) => new Promise((done) => setTimeout(done, ms));
export async function poll(test, label, timeout = 15000) {
  for (const end = Date.now() + timeout; Date.now() < end; await wait(50)) if (test()) return;
  throw new Error(`timed out waiting for ${label}`);
}
